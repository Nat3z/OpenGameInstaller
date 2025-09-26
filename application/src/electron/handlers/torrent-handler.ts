import axios from 'axios';
import { ipcMain, BrowserWindow } from 'electron';
import { sendNotification } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import { rm as rmAsync, readFile } from 'fs/promises';
import { getStoredValue, refreshCached } from '../config-util.js';
import { QBittorrent } from '@ctrl/qbittorrent';
import { torrent as wtConnect } from '../webtorrent-connect.js';
import { __dirname } from '../paths.js';
import { DOWNLOAD_QUEUE } from '../queue.js';
import ParseTorrent from 'parse-torrent';

let qbitClient: QBittorrent | undefined = undefined;

type TorrentDownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'seeding';

interface TorrentJob {
  link: string;
  path: string;
  type: 'torrent' | 'magnet';
}

const downloads = new Map<string, TorrentDownload>();

class TorrentDownload {
  public id: string;
  private _status: TorrentDownloadStatus = 'queued';

  public get status(): TorrentDownloadStatus {
    return this._status;
  }

  public set status(newStatus: TorrentDownloadStatus) {
    this._status = newStatus;
  }

  private mainWindow: BrowserWindow;
  private job: TorrentJob;
  private taskFinisher: () => void = () => {};
  private torrentClientType: 'webtorrent' | 'qbittorrent' | 'unselected' =
    'unselected';

  // WebTorrent specific
  private wtInstance?: ReturnType<typeof wtConnect>;
  private wtBlock?: {
    pause: () => void;
    resume: () => void;
    destroy: () => void;
  };

  // qBittorrent specific
  private qbitTorrentHash?: string;
  private qbitCheckInterval?: NodeJS.Timeout;
  private qbitProgressInterval?: NodeJS.Timeout;

  private progressInterval?: NodeJS.Timeout;

  private totalSize: number = 0;
  private downloadSpeed: number = 0;
  private progress: number = 0;
  private ratio: number = 0;

  constructor(mainWindow: BrowserWindow, job: TorrentJob) {
    this.id = Math.random().toString(36).substring(7);
    this.mainWindow = mainWindow;
    this.job = job;

    downloads.set(this.id, this);
  }

  public async start() {
    const { wait, finish, cancelHandler } = DOWNLOAD_QUEUE.enqueue(this.id, {
      type: 'torrent',
    });
    this.taskFinisher = finish;

    cancelHandler((cancel) => {
      ipcMain.handleOnce(`queue:${this.id}:cancel`, (_) => {
        cancel();
        this.cancel();
      });
    });

    const result = await wait((queuePosition) => {
      this.sendProgress({ queuePosition });
    });

    ipcMain.removeHandler(`queue:${this.id}:cancel`);

    if (result === 'cancelled') {
      return;
    }

    console.log('[torrent] Starting download...');
    this.run();
  }

  private async run() {
    this.status = 'downloading';
    try {
      await refreshCached('general');
      this.torrentClientType =
        ((await getStoredValue('general', 'torrentClient')) as
          | 'webtorrent'
          | 'qbittorrent') ?? 'webtorrent';

      if (this.torrentClientType === 'webtorrent') {
        await this.runWebTorrent();
      } else if (this.torrentClientType === 'qbittorrent') {
        await this.runQbittorrent();
      } else {
        throw new Error('No torrent client configured');
      }
    } catch (error) {
      this.fail(error as Error);
    }
  }

  private async runWebTorrent() {
    let torrentId: string | Buffer = this.job.link;
    if (this.job.type === 'torrent') {
      torrentId = await this.downloadTorrentFile(this.job.link);
    }

    this.wtInstance = wtConnect(torrentId, this.job.path + '.torrent');

    this.startProgressTracker();

    this.wtBlock = await this.wtInstance.start(
      (
        _: any,
        speed: number,
        progress: number,
        length: number,
        ratio: number
      ) => {
        this.downloadSpeed = speed;
        this.progress = progress;
        this.totalSize = length;
        this.ratio = ratio;
      },
      () => {
        this.status = 'seeding';
        this.progress = 1;
        this.sendProgress({});
        this.sendIpc('torrent:download-complete', { id: this.id });
        sendNotification({
          message: 'Download completed, now seeding.',
          id: this.id,
          type: 'success',
        });
        this.wtInstance?.seed();
        // Don't call task finisher until seeding is stopped (e.g., by cancellation)
      }
    );
  }

  private async runQbittorrent() {
    qbitClient = await this.setupQbitClient();

    if (this.job.type === 'torrent') {
      const torrentData = await this.downloadTorrentFile(this.job.link);
      await qbitClient.addTorrent(torrentData, {
        savepath: this.job.path,
      });
    } else {
      await qbitClient.addMagnet(this.job.link, {
        savepath: this.job.path,
      });
    }

    this.startQbitProgressTracker();
  }

  private async setupQbitClient() {
    await refreshCached('qbittorrent');
    return new QBittorrent({
      baseUrl:
        ((await getStoredValue('qbittorrent', 'qbitHost')) ??
          'http://127.0.0.1') +
        ':' +
        ((await getStoredValue('qbittorrent', 'qbitPort')) ?? '8080'),
      username:
        (await getStoredValue('qbittorrent', 'qbitUsername')) ?? 'admin',
      password: (await getStoredValue('qbittorrent', 'qbitPassword')) ?? '',
    });
  }

  private async downloadTorrentFile(link: string): Promise<Buffer> {
    const tempPath = join(__dirname, `temp-${this.id}.torrent`);
    const response = await axios({
      method: 'get',
      url: link,
      responseType: 'stream',
    });

    const fileStream = fs.createWriteStream(tempPath);
    response.data.pipe(fileStream);

    return new Promise((resolve, reject) => {
      fileStream.on('finish', async () => {
        fileStream.close();
        const buffer = await readFile(tempPath);
        await rmAsync(tempPath, { force: true });
        resolve(buffer);
      });
      fileStream.on('error', (err) => {
        fileStream.close();
        rmAsync(tempPath, { force: true });
        reject(err);
      });
    });
  }

  public pause() {
    if (this.status !== 'downloading') return;
    this.status = 'paused';

    if (this.torrentClientType === 'webtorrent') {
      this.wtBlock?.pause();
    } else if (
      this.torrentClientType === 'qbittorrent' &&
      this.qbitTorrentHash
    ) {
      qbitClient?.pauseTorrent(this.qbitTorrentHash);
    }

    this.sendIpc('torrent:download-paused', { id: this.id });
    sendNotification({
      message: 'Download paused',
      id: this.id,
      type: 'info',
    });
  }

  public resume() {
    if (this.status !== 'paused') return;
    this.status = 'downloading';

    if (this.torrentClientType === 'webtorrent') {
      this.wtBlock?.resume();
    } else if (
      this.torrentClientType === 'qbittorrent' &&
      this.qbitTorrentHash
    ) {
      qbitClient?.resumeTorrent(this.qbitTorrentHash);
    }

    this.sendIpc('torrent:download-resumed', { id: this.id });
    sendNotification({
      message: 'Download resumed',
      id: this.id,
      type: 'info',
    });
  }

  public cancel() {
    if (this.status === 'cancelled' || this.status === 'completed') return;
    this.status = 'cancelled';

    if (this.torrentClientType === 'webtorrent') {
      this.wtBlock?.destroy();
    } else if (
      this.torrentClientType === 'qbittorrent' &&
      this.qbitTorrentHash
    ) {
      qbitClient?.removeTorrent(this.qbitTorrentHash, true);
    }

    this.cleanup();

    this.sendIpc('torrent:download-cancelled', { id: this.id });
    console.log('[torrent] Download Cancelled', this.id);
    this.taskFinisher();
    downloads.delete(this.id);
  }

  private complete() {
    this.status = 'completed';
    this.sendProgress({ progress: 1, downloadSpeed: 0 });
    this.sendIpc('torrent:download-complete', { id: this.id });
    sendNotification({
      message: 'Download completed',
      id: this.id,
      type: 'success',
    });
    this.cleanup();
    this.taskFinisher();
    downloads.delete(this.id);
  }

  private fail(error: Error) {
    this.status = 'failed';
    this.sendIpc('torrent:download-error', {
      id: this.id,
      error: error.message,
    });
    sendNotification({
      message: 'Download failed',
      id: this.id,
      type: 'error',
    });
    console.error(`[torrent] Download ${this.id} failed:`, error);
    this.cleanup();
    this.taskFinisher();
    downloads.delete(this.id);
  }

  private startProgressTracker() {
    this.progressInterval = setInterval(() => {
      if (this.status === 'downloading' || this.status === 'seeding') {
        this.sendProgress({});
      }
    }, 500);
  }

  private startQbitProgressTracker() {
    this.qbitCheckInterval = setInterval(async () => {
      if (!qbitClient) return;

      try {
        const torrents = (await qbitClient.getAllData()).torrents;
        let torrent;

        if (!this.qbitTorrentHash) {
          torrent = torrents.find(
            (t) =>
              t.savePath === this.job.path.replaceAll('/', '\\') ||
              t.savePath === this.job.path
          );
          if (torrent) {
            this.qbitTorrentHash = torrent.id;
            console.log(
              `[torrent-handler] Found torrent hash: ${this.qbitTorrentHash}`
            );
          }
        } else {
          torrent = torrents.find((t) => t.id === this.qbitTorrentHash);
        }

        if (torrent) {
          this.downloadSpeed = torrent.downloadSpeed;
          this.progress = torrent.progress;
          this.totalSize = torrent.totalSize;
          this.ratio = torrent.totalUploaded / torrent.totalDownloaded;

          if (torrent.isCompleted) {
            this.complete();
          }
        }
      } catch (error) {
        console.error('[torrent] Error getting qBitTorrent data:', error);
        this.fail(error as Error);
      }
    }, 1000);

    this.qbitProgressInterval = setInterval(() => {
      if (this.status === 'downloading') {
        this.sendProgress({});
      }
    }, 500);
  }

  private sendProgress(data: {
    progress?: number;
    downloadSpeed?: number;
    queuePosition?: number;
    ratio?: number;
  }) {
    this.sendIpc('torrent:download-progress', {
      id: this.id,
      progress: data.progress ?? this.progress,
      downloadSpeed: data.downloadSpeed ?? this.downloadSpeed,
      fileSize: this.totalSize,
      ratio: data.ratio ?? this.ratio,
      status: this.status,
      queuePosition: data.queuePosition,
    });
  }

  private cleanup() {
    if (this.progressInterval) clearInterval(this.progressInterval);
    if (this.qbitCheckInterval) clearInterval(this.qbitCheckInterval);
    if (this.qbitProgressInterval) clearInterval(this.qbitProgressInterval);
  }

  private sendIpc(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

export default function handler(mainWindow: BrowserWindow) {
  const startDownload = async (job: TorrentJob) => {
    const download = new TorrentDownload(mainWindow, job);
    download.start();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return download.id;
  };

  ipcMain.handle(
    'torrent:download-torrent',
    (_, arg: { link: string; path: string }) => {
      return startDownload({ ...arg, type: 'torrent' });
    }
  );

  ipcMain.handle(
    'torrent:download-magnet',
    (_, arg: { link: string; path: string }) => {
      return startDownload({ ...arg, type: 'magnet' });
    }
  );

  ipcMain.handle('torrent:pause', (_, id: string) => {
    downloads.get(id)?.pause();
  });

  ipcMain.handle('torrent:resume', (_, id: string) => {
    downloads.get(id)?.resume();
  });

  ipcMain.handle('torrent:abort', (_, id: string) => {
    downloads.get(id)?.cancel();
  });

  ipcMain.handle('download-torrent-into', async (_, link: string) => {
    const tempPath = join(__dirname, 'temp.torrent');
    const fileStream = fs.createWriteStream(tempPath);
    const response = await axios({
      method: 'get',
      url: link,
      responseType: 'stream',
    });
    response.data.pipe(fileStream);
    return new Promise<Buffer>((resolve, reject) => {
      fileStream.on('finish', async () => {
        fileStream.close();
        const buffer = await readFile(tempPath);
        await rmAsync(tempPath, { force: true });
        resolve(buffer);
      });
      fileStream.on('error', (err) => {
        fileStream.close();
        rmAsync(tempPath, { force: true });
        reject(err);
      });
    });
  });

  ipcMain.handle(
    'torrent:get-hash',
    async (_, item: string | Buffer | Uint8Array) => {
      const parsed = await (ParseTorrent as any)(item);
      return parsed.infoHash;
    }
  );
}
