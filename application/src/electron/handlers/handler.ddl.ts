import { ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import { rm as rmAsync } from 'fs/promises';
import { sendNotification } from '../main.js';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { dirname } from 'path';
import { DOWNLOAD_QUEUE } from '../manager/manager.queue.js';
import { Readable } from 'stream';
import * as http from 'http';
import * as https from 'https';

// Parallel download configuration
const PARALLEL_DOWNLOAD_THRESHOLD = 100 * 1024 * 1024; // 100MB in bytes
const PARALLEL_CHUNK_COUNT = 4; // Number of parallel connections

interface DownloadJob {
  link: string;
  path: string;
  headers?: Record<string, string>;
}

interface ChunkState {
  index: number;
  startByte: number;
  endByte: number;
  currentBytes: number;
  abortController: AbortController;
  fileStream?: fs.WriteStream;
  response?: AxiosResponse<Readable>;
  completed: boolean;
}

interface ParallelDownloadInfo {
  useParallel: boolean;
  fileSize: number;
  supportsRange: boolean;
}

type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

const downloads = new Map<string, Download>();

class Download {
  public id: string;
  private _status: DownloadStatus = 'queued';

  public get status(): DownloadStatus {
    return this._status;
  }

  public set status(newStatus: DownloadStatus) {
    this._status = newStatus;
  }

  private mainWindow: BrowserWindow;
  private jobs: DownloadJob[];
  private totalParts: number;
  private currentPart: number = 0;
  private taskFinisher: () => void = () => {};

  private response?: AxiosResponse<Readable>;
  private fileStream?: fs.WriteStream;
  private progressInterval?: NodeJS.Timeout;
  private abortController?: AbortController;

  private currentBytes: number = 0;
  private totalSize: number = 0;
  private startByte: number = 0;
  private startTime: number = 0;

  // Parallel download state
  private useParallel: boolean = false;
  private chunks: ChunkState[] = [];
  private parallelTotalSize: number = 0;
  private currentJobPath: string = ''; // Track current job path for chunk file cleanup

  constructor(
    mainWindow: BrowserWindow,
    jobs: DownloadJob[],
    startPart: number = 1
  ) {
    this.id = Math.random().toString(36).substring(7);
    this.mainWindow = mainWindow;
    this.jobs = jobs;
    this.totalParts = jobs.length;
    this.currentPart = startPart || 1;

    downloads.set(this.id, this);
  }

  public async start() {
    const { wait, finish, cancelHandler } = DOWNLOAD_QUEUE.enqueue(this.id, {
      type: 'direct',
    });
    this.taskFinisher = finish;

    cancelHandler((cancel) => {
      ipcMain.handleOnce(`queue:${this.id}:cancel`, (_) => {
        cancel();
        this.cancel();
      });
    });

    const result = await wait((queuePosition) => {
      console.log('queuePosition', queuePosition);
    });

    if (result === 'cancelled') {
      return;
    }

    ipcMain.removeHandler(`queue:${this.id}:cancel`);

    console.log('[direct] Starting download...');

    this.run();
  }

  private async run() {
    this.status = 'downloading';
    try {
      for (let i = this.currentPart; i <= this.totalParts; i++) {
        this.currentPart = i;
        const job = this.jobs[i - 1];
        console.log('[direct] Downloading part', i);
        await this.downloadPart(job);
        console.log('[direct] Completed downloading part', i);
      }
      console.log('[direct] Completed downloading all parts');
      this.complete();
    } catch (error) {
      if (!['paused', 'cancelled'].includes(this.status)) {
        this.fail(error as Error);
      }
    }
  }

  public pause() {
    if (this.status !== 'downloading') return;

    this.status = 'paused';

    if (this.useParallel) {
      // Abort all chunk downloads
      for (const chunk of this.chunks) {
        chunk.abortController.abort();
        if (chunk.fileStream) {
          chunk.fileStream.close();
          chunk.fileStream = undefined;
        }
        chunk.response = undefined;
      }
      if (this.progressInterval) {
        clearInterval(this.progressInterval);
        this.progressInterval = undefined;
      }
    } else {
      this.abortController?.abort();
      this.response?.data.destroy();
    }

    console.log('[direct] Download paused');
    this.sendIpc('ddl:download-paused', { id: this.id });
    sendNotification({
      message: 'Download paused',
      id: this.id,
      type: 'info',
    });
  }

  public resume() {
    if (this.status !== 'paused') return;
    this.status = 'downloading';

    // Reset parallel state - will be re-evaluated in downloadPart
    if (this.useParallel) {
      this.useParallel = false;
      // Reset abort controllers for chunks (they'll be recreated)
      for (const chunk of this.chunks) {
        chunk.abortController = new AbortController();
      }
      this.chunks = [];
    }

    this.sendIpc('ddl:download-resumed', { id: this.id });
    this.run();
  }

  public cancel() {
    if (this.status === 'cancelled' || this.status === 'completed') return;

    this.status = 'cancelled';

    if (this.useParallel) {
      // Abort all chunk downloads
      for (const chunk of this.chunks) {
        chunk.abortController.abort();
      }
      this.cleanupParallelChunks();
    } else {
      this.abortController?.abort();
      this.cleanupPart();
    }

    this.cleanupAllFiles().then(() => {
      this.sendIpc('ddl:download-cancelled', { id: this.id });
      this.taskFinisher();
      console.log('[direct] Download Cancelled', this.id);
      downloads.delete(this.id);
    });
  }

  private complete() {
    console.log('[direct] Download completed');
    this.status = 'completed';

    // Clean up any remaining resources
    if (this.useParallel) {
      this.cleanupParallelChunks();
    } else {
      this.cleanupPart();
    }

    this.sendProgress({ progress: 1, downloadSpeed: 0 });
    this.sendIpc('ddl:download-complete', { id: this.id });
    sendNotification({
      message: 'Download completed',
      id: this.id,
      type: 'success',
    });
    this.taskFinisher();
    downloads.delete(this.id);
  }

  private fail(error: Error) {
    this.status = 'failed';

    if (this.useParallel) {
      this.cleanupParallelChunks();
    } else {
      this.cleanupPart();
    }

    this.cleanupAllFiles().then(() => {
      this.sendIpc('ddl:download-error', { id: this.id, error: error.message });
      sendNotification({
        message: 'Download failed',
        id: this.id,
        type: 'error',
      });
      this.taskFinisher();
      downloads.delete(this.id);
    });
  }

  private async downloadPart(job: DownloadJob, retries = 5) {
    let lastError: Error | undefined;

    // Check if we should use parallel download (only for single-part downloads)
    if (this.totalParts === 1) {
      const parallelInfo = await this.shouldUseParallelDownload(job);
      if (parallelInfo.useParallel) {
        console.log('[direct] Using parallel download');
        for (let i = 0; i < retries; i++) {
          if (this.status !== 'downloading')
            throw new Error('Download not active');
          try {
            await this.executeParallelDownload(job, parallelInfo.fileSize);
            console.log('[direct] Parallel download completed');
            return;
          } catch (error) {
            lastError = error as Error;
            console.log(
              '[direct] Error in parallel download attempt',
              i,
              lastError
            );
            if (this.status !== 'downloading') throw lastError;
            await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
          }
        }
        throw lastError;
      }
    }

    // Standard download
    for (let i = 0; i < retries; i++) {
      if (this.status !== 'downloading') throw new Error('Download not active');
      try {
        console.log('[direct] Attempting to download part', this.currentPart);
        await this._executeDownloadPart(job);
        console.log('[direct] Download Completed of Part', this.currentPart);
        return;
      } catch (error) {
        lastError = error as Error;
        console.log('[direct] Error downloading part', i, lastError);
        if (this.status !== 'downloading') throw lastError;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    throw lastError;
  }

  private _executeDownloadPart(job: DownloadJob) {
    return new Promise<void>(async (resolve, reject) => {
      this.sendProgress({ progress: 0, downloadSpeed: 0 });
      try {
        this.abortController = new AbortController();
        // send an alive progress to say that we're starting
        if (fs.existsSync(job.path)) {
          this.startByte = fs.statSync(job.path).size;
          console.log('[direct] Existing file found, size: ', this.startByte);
        } else {
          this.startByte = 0;
          console.log(
            '[direct] No existing file found, starting from beginning'
          );
        }
        this.currentBytes = this.startByte;

        fs.mkdirSync(dirname(job.path), { recursive: true });
        this.fileStream = fs.createWriteStream(job.path, {
          flags: this.startByte > 0 ? 'r+' : 'w',
          start: this.startByte,
        });
        console.log('[direct] Created file stream');

        const headers = {
          ...job.headers,
          'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
          'Accept-Encoding': 'identity',
          ...(this.startByte > 0 && { Range: `bytes=${this.startByte}-` }),
        };

        const keepAliveAgent = job.link.startsWith('https')
          ? new https.Agent({ keepAlive: true })
          : new http.Agent({ keepAlive: true });

        this.response = await axios.get<Readable>(job.link, {
          responseType: 'stream',
          headers,
          httpAgent: keepAliveAgent,
          httpsAgent: keepAliveAgent,
          signal: this.abortController.signal,
        });

        console.log('[direct] Stream received');

        if (this.startByte > 0 && this.response.status !== 206) {
          // Server doesn't support range requests, restart download
          this.startByte = 0;
          this.currentBytes = 0;
          if (this.fileStream) {
            this.fileStream.close();
          }
          await rmAsync(job.path, { force: true });
          // restart
          console.log(
            "[direct] Restarting download (doesn't support range requests)"
          );
          this._executeDownloadPart(job).then(resolve).catch(reject);
          return;
        }

        const contentLength = this.response.headers['content-length']
          ? parseInt(this.response.headers['content-length'], 10)
          : 0;
        this.totalSize = this.startByte + contentLength;
        this.startTime = Date.now();
        this.startProgressTracker();

        const stream = this.response.data.pipe(this.fileStream);

        stream.on('finish', () => {
          this.cleanupPart();
          console.log(
            '[direct] Stream finished (Downloaded bytes:',
            `${(this.currentBytes / (1024 * 1024)).toFixed(2)} MB)`
          );
          resolve();
        });

        this.abortController.signal.addEventListener('abort', () => {
          stream.destroy();
          console.log('[direct] Aborted');
          reject(new Error('Aborted'));
        });

        stream.on('error', (error) => {
          this.cleanupPart();
          console.log('[direct] Error', error);
          reject(error);
        });

        this.response.data.on('data', (chunk: Buffer) => {
          this.currentBytes += chunk.length;
        });
      } catch (error) {
        if (!(error instanceof AxiosError)) {
          this.cleanupPart();
          reject(error);
          return;
        }
        if (error.response?.status === 416) {
          console.log('[direct] Range not satisfiable, restarting download');
          this.startByte = 0;
          this.currentBytes = 0;
          if (this.fileStream) {
            this.fileStream.close();
          }
          await rmAsync(job.path, { force: true });
          // restart
          console.log('[direct] Restarting download (Range not satisfiable)');
          this._executeDownloadPart(job).then(resolve).catch(reject);
          return;
        } else if (error.response?.status === 404) {
          console.log('[direct] File not found. Killing download');
          this.cancel();
          this.cleanupAllFiles().then(() => {
            reject(error);
          });
          this.cleanupPart();
          return;
        }
        this.cleanupPart();
        reject(error);
      }
    });
  }

  private startProgressTracker() {
    this.progressInterval = setInterval(() => {
      if (this.useParallel) {
        // Aggregate progress from all chunks
        const totalDownloaded = this.chunks.reduce(
          (sum, chunk) => sum + chunk.currentBytes,
          0
        );
        const elapsedTime = (Date.now() - this.startTime) / 1000;
        const downloadSpeed =
          elapsedTime > 0 ? totalDownloaded / elapsedTime : 0;
        const progress =
          this.parallelTotalSize > 0
            ? totalDownloaded / this.parallelTotalSize
            : 0;

        this.sendProgress({ progress, downloadSpeed });
      } else {
        const elapsedTime = (Date.now() - this.startTime) / 1000;
        const downloadSpeed =
          elapsedTime > 0
            ? (this.currentBytes - this.startByte) / elapsedTime
            : 0;
        const progress =
          this.totalSize > 0 ? this.currentBytes / this.totalSize : 0;

        this.sendProgress({ progress, downloadSpeed });
      }
    }, 500);
  }

  /**
   * Check if parallel download should be used for this job.
   * Sends a HEAD request to get file size and check range support.
   */
  private async shouldUseParallelDownload(
    job: DownloadJob
  ): Promise<ParallelDownloadInfo> {
    try {
      const keepAliveAgent = job.link.startsWith('https')
        ? new https.Agent({ keepAlive: true })
        : new http.Agent({ keepAlive: true });

      const headResponse = await axios.head(job.link, {
        headers: {
          ...job.headers,
          'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
        },
        httpAgent: keepAliveAgent,
        httpsAgent: keepAliveAgent,
        timeout: 10000,
      });

      const contentLength = headResponse.headers['content-length']
        ? parseInt(headResponse.headers['content-length'], 10)
        : 0;
      const acceptRanges = headResponse.headers['accept-ranges'];
      const supportsRange = acceptRanges === 'bytes';

      const useParallel =
        supportsRange &&
        contentLength > PARALLEL_DOWNLOAD_THRESHOLD &&
        this.totalParts === 1; // Only use parallel for single-file downloads

      console.log(
        `[direct] Parallel check: size=${(contentLength / (1024 * 1024 * 1024)).toFixed(2)}GB, ` +
          `supportsRange=${supportsRange}, useParallel=${useParallel}`
      );

      return {
        useParallel,
        fileSize: contentLength,
        supportsRange,
      };
    } catch (error) {
      console.log(
        '[direct] HEAD request failed, falling back to standard download:',
        error
      );
      return {
        useParallel: false,
        fileSize: 0,
        supportsRange: false,
      };
    }
  }

  /**
   * Execute a parallel download by splitting the file into chunks.
   * Each chunk downloads to a separate file, then merges at the end.
   */
  private async executeParallelDownload(
    job: DownloadJob,
    fileSize: number
  ): Promise<void> {
    this.useParallel = true;
    this.parallelTotalSize = fileSize;
    this.currentJobPath = job.path;
    this.chunks = [];

    // Calculate chunk sizes
    const chunkSize = Math.ceil(fileSize / PARALLEL_CHUNK_COUNT);

    // Create the target directory
    fs.mkdirSync(dirname(job.path), { recursive: true });

    // Initialize chunks - check each chunk file individually for resume
    for (let i = 0; i < PARALLEL_CHUNK_COUNT; i++) {
      const startByte = i * chunkSize;
      const endByte = Math.min((i + 1) * chunkSize - 1, fileSize - 1);
      const expectedChunkSize = endByte - startByte + 1;
      const chunkPath = this.getChunkPath(job.path, i);

      // Check if this chunk file exists and how much was downloaded
      let chunkCurrentBytes = 0;
      if (fs.existsSync(chunkPath)) {
        chunkCurrentBytes = fs.statSync(chunkPath).size;
        console.log(
          `[direct] Chunk ${i} file exists with ${chunkCurrentBytes} bytes`
        );
      }

      this.chunks.push({
        index: i,
        startByte,
        endByte,
        currentBytes: chunkCurrentBytes,
        abortController: new AbortController(),
        completed: chunkCurrentBytes >= expectedChunkSize,
      });
    }

    this.startTime = Date.now();
    this.startProgressTracker();

    console.log(
      `[direct] Starting parallel download with ${PARALLEL_CHUNK_COUNT} chunks, ` +
        `chunk size: ${(chunkSize / (1024 * 1024)).toFixed(2)}MB`
    );

    // Download all chunks in parallel
    const chunkPromises = this.chunks.map((chunk) =>
      this.downloadChunk(job, chunk)
    );

    try {
      await Promise.all(chunkPromises);
      console.log('[direct] All parallel chunks completed');
    } catch (error) {
      // Clean up all chunks on failure
      this.cleanupParallelChunks();
      throw error;
    }

    this.cleanupParallelChunks();

    // Merge all chunk files into the final file
    await this.mergeChunkFiles(job);
  }

  /**
   * Download a single chunk of the file to a separate chunk file.
   */
  private downloadChunk(job: DownloadJob, chunk: ChunkState): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      if (chunk.completed) {
        console.log(`[direct] Chunk ${chunk.index} already complete, skipping`);
        resolve();
        return;
      }

      // Calculate the actual byte position in the remote file
      const actualStartByte = chunk.startByte + chunk.currentBytes;

      if (actualStartByte > chunk.endByte) {
        console.log(`[direct] Chunk ${chunk.index} already downloaded`);
        chunk.completed = true;
        resolve();
        return;
      }

      const chunkPath = this.getChunkPath(job.path, chunk.index);

      try {
        const keepAliveAgent = job.link.startsWith('https')
          ? new https.Agent({ keepAlive: true })
          : new http.Agent({ keepAlive: true });

        const headers = {
          ...job.headers,
          'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
          'Accept-Encoding': 'identity',
          Range: `bytes=${actualStartByte}-${chunk.endByte}`,
        };

        console.log(
          `[direct] Chunk ${chunk.index}: downloading bytes ${actualStartByte}-${chunk.endByte} to ${chunkPath}`
        );

        chunk.response = await axios.get<Readable>(job.link, {
          responseType: 'stream',
          headers,
          httpAgent: keepAliveAgent,
          httpsAgent: keepAliveAgent,
          signal: chunk.abortController.signal,
        });

        // Check for 206 Partial Content response
        if (chunk.response.status !== 206) {
          console.log(
            `[direct] Chunk ${chunk.index}: unexpected status ${chunk.response.status}`
          );
          reject(
            new Error(
              `Unexpected status ${chunk.response.status} for range request`
            )
          );
          return;
        }

        // Create file stream for this chunk file
        // Use append mode if resuming, write mode if starting fresh
        chunk.fileStream = fs.createWriteStream(chunkPath, {
          flags: chunk.currentBytes > 0 ? 'a' : 'w',
        });

        const stream = chunk.response.data.pipe(chunk.fileStream);

        stream.on('finish', () => {
          chunk.completed = true;
          console.log(`[direct] Chunk ${chunk.index} completed`);
          resolve();
        });

        chunk.abortController.signal.addEventListener('abort', () => {
          stream.destroy();
          console.log(`[direct] Chunk ${chunk.index} aborted`);
          reject(new Error('Aborted'));
        });

        stream.on('error', (error) => {
          console.log(`[direct] Chunk ${chunk.index} error:`, error);
          reject(error);
        });

        chunk.response.data.on('data', (data: Buffer) => {
          chunk.currentBytes += data.length;
        });
      } catch (error) {
        if (error instanceof AxiosError) {
          if (error.response?.status === 416) {
            // Range not satisfiable - chunk is complete
            console.log(
              `[direct] Chunk ${chunk.index}: range not satisfiable, marking complete`
            );
            chunk.completed = true;
            resolve();
            return;
          }
        }
        console.log(`[direct] Chunk ${chunk.index} failed:`, error);
        reject(error);
      }
    });
  }

  /**
   * Clean up all parallel chunk resources.
   */
  private cleanupParallelChunks() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = undefined;
    }

    for (const chunk of this.chunks) {
      if (chunk.fileStream) {
        chunk.fileStream.close();
        chunk.fileStream = undefined;
      }
      chunk.response = undefined;
    }
  }

  /**
   * Merge all chunk files into the final file and delete chunk files.
   */
  private async mergeChunkFiles(job: DownloadJob): Promise<void> {
    console.log('[direct] Merging chunk files into final file...');

    // Create the final file write stream
    const finalStream = fs.createWriteStream(job.path, { flags: 'w' });

    return new Promise<void>((resolve, reject) => {
      let currentChunkIndex = 0;

      const writeNextChunk = () => {
        if (currentChunkIndex >= PARALLEL_CHUNK_COUNT) {
          // All chunks merged, close the stream
          finalStream.end(() => {
            console.log('[direct] Merge complete, deleting chunk files...');
            // Delete all chunk files
            this.deleteChunkFiles(job.path)
              .then(() => {
                console.log('[direct] Chunk files deleted');
                resolve();
              })
              .catch((err) => {
                console.error('[direct] Failed to delete chunk files:', err);
                // Still resolve since merge succeeded
                resolve();
              });
          });
          return;
        }

        const chunkPath = this.getChunkPath(job.path, currentChunkIndex);

        if (!fs.existsSync(chunkPath)) {
          reject(new Error(`Chunk file ${chunkPath} not found for merge`));
          return;
        }

        const chunkStream = fs.createReadStream(chunkPath);

        chunkStream.on('error', (err) => {
          finalStream.destroy();
          reject(err);
        });

        chunkStream.on('end', () => {
          currentChunkIndex++;
          writeNextChunk();
        });

        chunkStream.pipe(finalStream, { end: false });
      };

      finalStream.on('error', (err) => {
        reject(err);
      });

      writeNextChunk();
    });
  }

  /**
   * Delete all chunk files for a job.
   */
  private async deleteChunkFiles(basePath: string): Promise<void> {
    const deletePromises: Promise<void>[] = [];
    for (let i = 0; i < PARALLEL_CHUNK_COUNT; i++) {
      const chunkPath = this.getChunkPath(basePath, i);
      deletePromises.push(
        rmAsync(chunkPath, { force: true }).catch((e) =>
          console.error(`Failed to delete chunk file ${chunkPath}`, e)
        )
      );
    }
    await Promise.all(deletePromises);
  }

  private sendProgress(data: {
    progress?: number;
    downloadSpeed?: number;
    queuePosition?: number;
  }) {
    this.sendIpc('ddl:download-progress', {
      id: this.id,
      progress: data.progress ?? 0,
      downloadSpeed: data.downloadSpeed ?? 0,
      fileSize: this.useParallel ? this.parallelTotalSize : this.totalSize,
      part: this.currentPart,
      status: this.status,
      totalParts: this.totalParts,
      queuePosition: 1,
    });
  }

  private cleanupPart() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = undefined;
    }
    if (this.fileStream) {
      this.fileStream.close();
    }
    this.response = undefined;
    this.fileStream = undefined;
    this.abortController = undefined;
  }

  private async cleanupAllFiles() {
    const cleanupPromises = this.jobs.map((job) =>
      rmAsync(job.path, { force: true }).catch((e) =>
        console.error(`Failed to delete ${job.path}`, e)
      )
    );

    // Also delete any chunk files if this was a parallel download
    if (this.currentJobPath) {
      for (let i = 0; i < PARALLEL_CHUNK_COUNT; i++) {
        const chunkPath = this.getChunkPath(this.currentJobPath, i);
        cleanupPromises.push(
          rmAsync(chunkPath, { force: true }).catch((e) =>
            console.error(`Failed to delete chunk file ${chunkPath}`, e)
          )
        );
      }
    }

    await Promise.all(cleanupPromises);
  }

  private sendIpc(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Get the path for a chunk file.
   */
  private getChunkPath(basePath: string, chunkIndex: number): string {
    return `${basePath}.chunk${chunkIndex}`;
  }
}

export default function handler(mainWindow: BrowserWindow) {
  ipcMain.handle(
    'ddl:download',
    async (
      _,
      args: { link: string; path: string; headers?: Record<string, string> }[],
      part?: number
    ) => {
      const download = new Download(mainWindow, args, part);
      download.start();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return download.id;
    }
  );

  ipcMain.handle('ddl:pause', (_, id: string) => {
    console.log('[direct] Pausing download', id);
    downloads.get(id)?.pause();
  });

  ipcMain.handle('ddl:resume', (_, id: string) => {
    console.log('[direct] Resuming download', id);
    downloads.get(id)?.resume();
  });

  ipcMain.handle('ddl:abort', (_, id: string) => {
    console.log('[direct] Aborting download', id);
    downloads.get(id)?.cancel();
  });
}
