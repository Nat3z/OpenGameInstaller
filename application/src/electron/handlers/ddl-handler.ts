import { ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import { rm as rmAsync } from 'fs/promises';
import { sendNotification } from '../main.js';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { dirname } from 'path';
import { DOWNLOAD_QUEUE } from '../queue.js';
import { Readable } from 'stream';
import * as http from 'http';
import * as https from 'https';

interface DownloadJob {
  link: string;
  path: string;
  headers?: Record<string, string>;
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
    this.abortController?.abort();
    this.response?.data.destroy();

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
    this.sendIpc('ddl:download-resumed', { id: this.id });
    this.run();
  }

  public cancel() {
    if (this.status === 'cancelled' || this.status === 'completed') return;

    this.status = 'cancelled';
    this.abortController?.abort();
    this.cleanupPart();
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
    this.cleanupPart();
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
      const elapsedTime = (Date.now() - this.startTime) / 1000;
      const downloadSpeed =
        elapsedTime > 0
          ? (this.currentBytes - this.startByte) / elapsedTime
          : 0;
      const progress =
        this.totalSize > 0 ? this.currentBytes / this.totalSize : 0;

      this.sendProgress({ progress, downloadSpeed });
    }, 500);
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
      fileSize: this.totalSize,
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
    await Promise.all(cleanupPromises);
  }

  private sendIpc(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
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
