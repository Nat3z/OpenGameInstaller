import { QBittorrent } from '@ctrl/qbittorrent';
import {
  formatError,
  HttpError,
  runEffectBoundary as run,
  TorrentError,
} from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import axios from 'axios';
import { Deferred, Effect, Fiber } from 'effect';
import { BrowserWindow } from 'electron';
import { getTorrentInfoHash } from '@/electron/lib/torrent-hash.js';
import { sendNotification } from '@/electron/main.js';
import {
  getStoredValue,
  refreshCached,
} from '@/electron/manager/manager.config.js';
import { DOWNLOAD_QUEUE } from '@/electron/manager/manager.queue.js';
import { torrent as wtConnect } from '@/electron/manager/manager.webtorrent.js';
import {
  registerQueueCancel,
  removeQueueCancel,
} from '@/electron/rpc/queue-cancel.js';
import { procedure, router } from '@/electron/rpc/router-core.js';
import {
  clearDownloadHandshake,
  type DownloadHandshakeResult,
  registerDownloadHandshake,
  updateDownloadHandshake,
  waitForDownloadHandshake,
} from '@/lib/download-handshake.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

function torrentError(message: string, cause?: unknown): TorrentError {
  if (cause instanceof TorrentError) return cause;
  return new TorrentError({ message, cause });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

function getQbitErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);

  if (message.toLowerCase().includes('unauthorized')) {
    return 'Could not authenticate with qBittorrent. Check your qBittorrent username and password.';
  }

  if (
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.includes('ETIMEDOUT') ||
    message.includes('fetch failed')
  ) {
    return 'Could not connect to qBittorrent. Check that the WebUI is running and your host/port settings are correct.';
  }

  return `qBittorrent error: ${message}`;
}

type TorrentDownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'seeding';

type TorrentClientType = 'webtorrent' | 'qbittorrent' | 'unselected';

interface TorrentJob {
  link: string;
  path: string;
  type: 'torrent' | 'magnet';
}

interface WebTorrentControls {
  pause: () => void;
  resume: () => void;
  destroy: () => void;
}

const downloads = new Map<string, TorrentDownload>();

class TorrentDownload {
  public readonly id: string;
  private _status: TorrentDownloadStatus = 'queued';

  public get status(): TorrentDownloadStatus {
    return this._status;
  }

  private readonly mainWindow: BrowserWindow;
  private readonly job: TorrentJob;
  private taskFinisher: () => void = () => {};
  private queueReleased = false;
  private torrentClientType: TorrentClientType = 'unselected';
  private lifecycleFiber?: Fiber.RuntimeFiber<void, never>;
  private progressFiber?: Fiber.RuntimeFiber<never, never>;
  private seedingFiber?: Fiber.RuntimeFiber<void, never>;

  private wtInstance?: ReturnType<typeof wtConnect>;
  private wtBlock?: WebTorrentControls;

  private qbitClient?: QBittorrent;
  private qbitTorrentHash?: string;
  private expectedInfoHash?: string;
  private qbitNotFoundTicks = 0;

  private static readonly QBIT_LOOKUP_TIMEOUT_TICKS = 60;

  private totalSize = 0;
  private downloadSpeed = 0;
  private progress = 0;
  private ratio = 0;

  constructor(mainWindow: BrowserWindow, job: TorrentJob) {
    this.id = Math.random().toString(36).substring(7);
    this.mainWindow = mainWindow;
    this.job = job;

    downloads.set(this.id, this);
    registerDownloadHandshake(this.id);
  }

  private setStatus(status: TorrentDownloadStatus): void {
    this._status = status;
  }

  private reportHandshake(
    update: Partial<DownloadHandshakeResult> = {},
    terminalEvent?: { channel: string; data: unknown }
  ): void {
    const status =
      update.status ??
      (this.status === 'failed'
        ? 'error'
        : this.status === 'seeding'
          ? 'seeding'
          : this.status === 'completed'
            ? 'completed'
            : this.status);

    updateDownloadHandshake(
      {
        id: this.id,
        status: status as DownloadHandshakeResult['status'],
        queuePosition: update.queuePosition,
        error: update.error,
      },
      terminalEvent
    );
  }

  public waitForReady(): Effect.Effect<DownloadHandshakeResult, TorrentError> {
    return Effect.tryPromise({
      try: () => waitForDownloadHandshake(this.id),
      catch: (cause) =>
        torrentError(
          `Failed to wait for torrent download readiness: ${formatError(cause)}`,
          cause
        ),
    });
  }

  public start(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      this.lifecycleFiber = yield* Effect.forkDaemon(this.lifecycle());
    });
  }

  private lifecycle(): Effect.Effect<void, never> {
    const download = Effect.scoped(
      Effect.gen(this, function* () {
        const queue = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const entry = DOWNLOAD_QUEUE.enqueue(this.id, { type: 'torrent' });
            this.taskFinisher = entry.finish;
            entry.cancelHandler((cancel) => {
              registerQueueCancel(this.id, () => {
                cancel();
                return run(this.cancel());
              });
            });
            return entry;
          }),
          () =>
            Effect.sync(() => {
              this.removeCancelHandler();
              this.releaseQueueSlot();
            })
        );

        const queueResult = yield* queue.wait((queuePosition) => {
          this.sendProgress({ queuePosition });
          this.reportHandshake({ status: 'queued', queuePosition });
        });

        if (queueResult === 'cancelled') return;

        logger.sync.info('[torrent] Starting download...');
        this.setStatus('downloading');
        this.reportHandshake({ status: 'downloading' });

        this.torrentClientType = yield* this.readTorrentClientType();
        if (this.torrentClientType === 'webtorrent') {
          yield* this.runWebTorrent();
          return;
        }
        if (this.torrentClientType === 'qbittorrent') {
          yield* this.runQbittorrent();
          return;
        }

        return yield* Effect.fail(
          new TorrentError({ message: 'No torrent client configured' })
        );
      }).pipe(Effect.tapError((error) => this.fail(error)))
    );

    return download.pipe(
      Effect.catchAll(() => Effect.void),
      Effect.ensuring(
        Effect.sync(() => {
          this.lifecycleFiber = undefined;
        })
      )
    );
  }

  private readTorrentClientType(): Effect.Effect<
    TorrentClientType,
    TorrentError
  > {
    return Effect.gen(function* () {
      yield* refreshCached('general');
      const configured: unknown = yield* getStoredValue(
        'general',
        'torrentClient'
      );
      if (configured === undefined) return 'webtorrent';
      if (configured === 'webtorrent' || configured === 'qbittorrent') {
        return configured;
      }
      return 'unselected';
    }).pipe(
      Effect.mapError((cause) =>
        torrentError(
          `Failed to read torrent client configuration: ${formatError(cause)}`,
          cause
        )
      )
    );
  }

  private runWebTorrent(): Effect.Effect<void, TorrentError> {
    return Effect.gen(this, function* () {
      this.progressFiber = yield* Effect.forkDaemon(this.trackProgress());
      const shouldSeed = yield* Effect.scoped(
        Effect.gen(this, function* () {
          const torrentId =
            this.job.type === 'torrent'
              ? yield* this.downloadTorrentFile(this.job.link)
              : this.job.link;
          this.wtInstance = wtConnect(torrentId, this.job.path + '.torrent');

          const completed = yield* Deferred.make<void>();
          this.wtBlock = yield* Effect.acquireRelease(
            this.wtInstance.start(
              (_, speed, progress, length, ratio) => {
                this.downloadSpeed = speed;
                this.progress = progress;
                this.totalSize = length;
                this.ratio = ratio;
              },
              () => {
                Effect.runFork(Deferred.succeed(completed, undefined));
              }
            ),
            (controls) =>
              Effect.sync(() => {
                try {
                  controls.destroy();
                } catch (cause) {
                  logger.sync.error(
                    '[torrent] Failed to release WebTorrent download:',
                    torrentError(
                      `Failed to release WebTorrent download: ${formatError(cause)}`,
                      cause
                    )
                  );
                } finally {
                  this.wtBlock = undefined;
                }
              })
          );

          yield* Deferred.await(completed);
          yield* Effect.sleep('1 second');

          if (this.status === 'cancelled' || this.status === 'failed') {
            return false;
          }

          yield* this.complete();
          return true;
        })
      );

      if (shouldSeed && this.wtInstance) {
        this.seedingFiber = yield* Effect.forkDaemon(
          this.wtInstance.seed().pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                logger.sync.error(
                  '[torrent] Failed to seed WebTorrent:',
                  error
                );
              })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                this.seedingFiber = undefined;
              })
            )
          )
        );
      }
    });
  }

  private runQbittorrent(): Effect.Effect<void, TorrentError> {
    return Effect.scoped(
      Effect.gen(this, function* () {
        yield* Effect.acquireRelease(this.addQbitTorrent(), () =>
          this.releaseQbitTorrent().pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                logger.sync.error(
                  '[torrent] Failed to clean up qBittorrent torrent:',
                  error
                );
              })
            )
          )
        );
        yield* Effect.forkScoped(this.trackProgress());
        yield* this.pollQbittorrent();
      })
    );
  }

  private setupQbitClient(): Effect.Effect<QBittorrent, TorrentError> {
    return Effect.gen(function* () {
      yield* refreshCached('qbittorrent');
      const host: unknown = yield* getStoredValue('qbittorrent', 'qbitHost');
      const port: unknown = yield* getStoredValue('qbittorrent', 'qbitPort');
      const username: unknown = yield* getStoredValue(
        'qbittorrent',
        'qbitUsername'
      );
      const password: unknown = yield* getStoredValue(
        'qbittorrent',
        'qbitPassword'
      );

      const configuredPort =
        typeof port === 'string' || typeof port === 'number'
          ? String(port)
          : '8080';
      return new QBittorrent({
        baseUrl: `${typeof host === 'string' ? host : 'http://127.0.0.1'}:${configuredPort}`,
        username: typeof username === 'string' ? username : 'admin',
        password: typeof password === 'string' ? password : '',
      });
    }).pipe(
      Effect.mapError((cause) =>
        torrentError(
          `Failed to read qBittorrent configuration: ${formatError(cause)}`,
          cause
        )
      )
    );
  }

  private addQbitTorrent(): Effect.Effect<void, TorrentError> {
    return Effect.gen(this, function* () {
      this.qbitClient = yield* this.setupQbitClient();

      if (this.job.type === 'torrent') {
        const torrentData = yield* this.downloadTorrentFile(this.job.link);
        this.expectedInfoHash = yield* getTorrentInfoHash(torrentData);
        const data = new Uint8Array(torrentData);
        yield* Effect.tryPromise({
          try: () =>
            this.qbitClient!.addTorrent(data, { savepath: this.job.path }),
          catch: (cause) => torrentError(getQbitErrorMessage(cause), cause),
        });
        return;
      }

      this.expectedInfoHash = yield* getTorrentInfoHash(this.job.link);
      yield* Effect.tryPromise({
        try: () =>
          this.qbitClient!.addMagnet(this.job.link, {
            savepath: this.job.path,
          }),
        catch: (cause) => torrentError(getQbitErrorMessage(cause), cause),
      });
    });
  }

  private findQbitTorrent<T extends { id: string; savePath: string }>(
    torrents: readonly T[]
  ): T | undefined {
    if (this.qbitTorrentHash) {
      return torrents.find((torrent) => torrent.id === this.qbitTorrentHash);
    }

    const normalizedJobPath = this.job.path.replace(/[/\\]+$/, '');
    return torrents.find((torrent) => {
      if (
        this.expectedInfoHash &&
        (torrent.id === this.expectedInfoHash ||
          (torrent as { hash?: string }).hash === this.expectedInfoHash)
      ) {
        return true;
      }
      const normalizedSavePath = torrent.savePath.replace(/[/\\]+$/, '');
      return (
        normalizedSavePath === normalizedJobPath.replace(/\//g, '\\') ||
        normalizedSavePath === normalizedJobPath
      );
    });
  }

  private getQbitTorrents(): Effect.Effect<
    Awaited<ReturnType<QBittorrent['getAllData']>>['torrents'],
    TorrentError
  > {
    if (!this.qbitClient) {
      return Effect.fail(
        new TorrentError({ message: 'qBittorrent client is not initialized' })
      );
    }
    return Effect.tryPromise({
      try: () => this.qbitClient!.getAllData().then((data) => data.torrents),
      catch: (cause) => torrentError(getQbitErrorMessage(cause), cause),
    });
  }

  private pollQbittorrent(): Effect.Effect<void, TorrentError> {
    return Effect.gen(this, function* () {
      while (this.status !== 'cancelled' && this.status !== 'failed') {
        const torrents = yield* this.getQbitTorrents();
        const torrent = this.findQbitTorrent(torrents);

        if (!torrent) {
          this.qbitNotFoundTicks++;
          if (
            this.qbitNotFoundTicks >= TorrentDownload.QBIT_LOOKUP_TIMEOUT_TICKS
          ) {
            return yield* Effect.fail(
              new TorrentError({
                message:
                  'Timed out waiting for qBittorrent to register the torrent.',
              })
            );
          }
          yield* Effect.sleep('1 second');
          continue;
        }

        if (!this.qbitTorrentHash) {
          this.qbitTorrentHash = torrent.id;
          logger.sync.info(
            `[torrent-handler] Found torrent hash: ${this.qbitTorrentHash}`
          );
        }
        this.qbitNotFoundTicks = 0;
        this.downloadSpeed = torrent.downloadSpeed;
        this.progress = torrent.progress;
        this.totalSize = torrent.totalSize;
        this.ratio = torrent.totalDownloaded
          ? torrent.totalUploaded / torrent.totalDownloaded
          : 0;

        if (torrent.isCompleted || torrent.progress >= 1) {
          yield* this.complete();
          return;
        }

        yield* Effect.sleep('1 second');
      }
    });
  }

  private releaseQbitTorrent(): Effect.Effect<void, TorrentError> {
    if (
      !this.qbitClient ||
      (this.status !== 'cancelled' && this.status !== 'failed')
    ) {
      return Effect.void;
    }

    return Effect.gen(this, function* () {
      let hash = this.qbitTorrentHash;
      if (!hash) {
        const torrents = yield* this.getQbitTorrents();
        hash = this.findQbitTorrent(torrents)?.id;
      }
      if (!hash) return;

      yield* Effect.tryPromise({
        try: () => this.qbitClient!.removeTorrent(hash, true),
        catch: (cause) =>
          torrentError(
            `Failed to remove qBittorrent torrent: ${getQbitErrorMessage(cause)}`,
            cause
          ),
      });
    });
  }

  private downloadTorrentFile(
    link: string
  ): Effect.Effect<Buffer, TorrentError> {
    return Effect.tryPromise({
      try: () => axios.get<ArrayBuffer>(link, { responseType: 'arraybuffer' }),
      catch: (cause) =>
        torrentError(
          axios.isAxiosError(cause)
            ? `Failed to download torrent file (${cause.response?.status ?? 'network error'}): ${cause.message}`
            : `Failed to download torrent file: ${formatError(cause)}`,
          cause
        ),
    }).pipe(Effect.map((response) => Buffer.from(response.data)));
  }

  public pause(): Effect.Effect<void, TorrentError> {
    if (this.status !== 'downloading') return Effect.void;

    return Effect.gen(this, function* () {
      if (this.torrentClientType === 'webtorrent') {
        yield* Effect.try({
          try: () => this.wtBlock?.pause(),
          catch: (cause) =>
            torrentError(
              `Failed to pause WebTorrent download: ${formatError(cause)}`,
              cause
            ),
        });
      } else if (
        this.torrentClientType === 'qbittorrent' &&
        this.qbitTorrentHash &&
        this.qbitClient
      ) {
        yield* Effect.tryPromise({
          try: () => this.qbitClient!.stopTorrent(this.qbitTorrentHash!),
          catch: (cause) => torrentError(getQbitErrorMessage(cause), cause),
        });
      }

      this.setStatus('paused');
      this.sendIpc('torrent:download-paused', { id: this.id });
      sendNotification({
        message: 'Download paused',
        id: this.id,
        type: 'info',
      });
    }).pipe(Effect.catchAll((error) => this.failAndReturn(error)));
  }

  public resume(): Effect.Effect<void, TorrentError> {
    if (this.status !== 'paused') return Effect.void;

    return Effect.gen(this, function* () {
      if (this.torrentClientType === 'webtorrent') {
        yield* Effect.try({
          try: () => this.wtBlock?.resume(),
          catch: (cause) =>
            torrentError(
              `Failed to resume WebTorrent download: ${formatError(cause)}`,
              cause
            ),
        });
      } else if (
        this.torrentClientType === 'qbittorrent' &&
        this.qbitTorrentHash &&
        this.qbitClient
      ) {
        yield* Effect.tryPromise({
          try: () => this.qbitClient!.startTorrent(this.qbitTorrentHash!),
          catch: (cause) => torrentError(getQbitErrorMessage(cause), cause),
        });
      }

      this.setStatus('downloading');
      this.sendIpc('torrent:download-resumed', { id: this.id });
      sendNotification({
        message: 'Download resumed',
        id: this.id,
        type: 'info',
      });
    }).pipe(Effect.catchAll((error) => this.failAndReturn(error)));
  }

  public cancel(): Effect.Effect<void, TorrentError> {
    if (
      this.status === 'cancelled' ||
      this.status === 'completed' ||
      this.status === 'failed'
    ) {
      return Effect.void;
    }

    return Effect.gen(this, function* () {
      this.setStatus('cancelled');
      const payload = { id: this.id };
      this.reportHandshake(
        { status: 'error', error: 'Download cancelled' },
        { channel: 'torrent:download-cancelled', data: payload }
      );
      this.sendIpc('torrent:download-cancelled', payload);
      logger.sync.info('[torrent] Download Cancelled', this.id);

      if (this.lifecycleFiber) {
        yield* Fiber.interrupt(this.lifecycleFiber);
      } else {
        this.removeCancelHandler();
        this.releaseQueueSlot();
      }
      if (this.seedingFiber) yield* Fiber.interrupt(this.seedingFiber);
      if (this.progressFiber) yield* Fiber.interrupt(this.progressFiber);
      this.seedingFiber = undefined;
      this.progressFiber = undefined;

      setImmediate(() => clearDownloadHandshake(this.id));
      downloads.delete(this.id);
    });
  }

  private complete(): Effect.Effect<void> {
    if (
      this.status === 'completed' ||
      this.status === 'seeding' ||
      this.status === 'cancelled' ||
      this.status === 'failed'
    ) {
      return Effect.void;
    }

    return Effect.sync(() => {
      // Keep the seeding state until the completion IPC event is emitted so the
      // renderer does not enter addon setup early.
      this.setStatus('seeding');
      this.progress = 1;
      this.sendProgress({ progress: 1, downloadSpeed: 0, ratio: this.ratio });
      const payload = { id: this.id };
      this.reportHandshake(
        { status: 'seeding' },
        { channel: 'torrent:download-complete', data: payload }
      );
      this.sendIpc('torrent:download-complete', payload);
      sendNotification({
        message: 'Download completed, now seeding.',
        id: this.id,
        type: 'success',
      });
      clearDownloadHandshake(this.id);
    });
  }

  private fail(error: TorrentError): Effect.Effect<void> {
    if (
      this.status === 'failed' ||
      this.status === 'cancelled' ||
      this.status === 'completed' ||
      this.status === 'seeding'
    ) {
      return Effect.void;
    }

    return Effect.sync(() => {
      this.setStatus('failed');
      const payload = { id: this.id, error: error.message };
      this.reportHandshake(
        { status: 'error', error: error.message },
        { channel: 'torrent:download-error', data: payload }
      );
      this.sendIpc('torrent:download-error', payload);
      sendNotification({
        message: error.message || 'Download failed',
        id: this.id,
        type: 'error',
      });
      logger.sync.error(`[torrent] Download ${this.id} failed:`, error);
      setImmediate(() => clearDownloadHandshake(this.id));
      downloads.delete(this.id);
    });
  }

  private failAndReturn(
    error: TorrentError
  ): Effect.Effect<void, TorrentError> {
    return Effect.gen(this, function* () {
      yield* this.fail(error);
      if (this.lifecycleFiber) yield* Fiber.interrupt(this.lifecycleFiber);
      return yield* Effect.fail(error);
    });
  }

  private trackProgress(): Effect.Effect<never> {
    return Effect.forever(
      Effect.sleep('500 millis').pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (this.status === 'downloading') {
              this.sendProgress({
                progress: this.progress,
                downloadSpeed: this.downloadSpeed,
                ratio: this.ratio,
                queuePosition: 1,
              });
            } else if (this.status === 'seeding') {
              this.sendProgress({
                progress: this.progress,
                downloadSpeed: this.downloadSpeed,
                ratio: this.ratio,
              });
            }
          })
        )
      )
    );
  }

  private removeCancelHandler(): void {
    removeQueueCancel(this.id);
  }

  private releaseQueueSlot(): void {
    if (this.queueReleased) return;
    this.queueReleased = true;
    this.taskFinisher();
  }

  private sendProgress(data: {
    progress?: number;
    downloadSpeed?: number;
    queuePosition?: number;
    ratio?: number;
  }): void {
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

  private sendIpc(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

export default function handler(mainWindow: BrowserWindow) {
  const startDownload = (job: TorrentJob) =>
    Effect.gen(function* () {
      const download = new TorrentDownload(mainWindow, job);
      yield* download.start();
      return yield* download.waitForReady();
    });

  return router(
    procedure(
      ElectronRpc.torrent.downloadTorrent,
      (link: string, path: string) =>
        run(startDownload({ link, path, type: 'torrent' }))
    ),
    procedure(
      ElectronRpc.torrent.downloadMagnet,
      (link: string, path: string) =>
        run(startDownload({ link, path, type: 'magnet' }))
    ),
    procedure(ElectronRpc.torrent.pauseDownload, (id: string) =>
      run(downloads.get(id)?.pause() ?? Effect.void)
    ),
    procedure(ElectronRpc.torrent.resumeDownload, (id: string) =>
      run(downloads.get(id)?.resume() ?? Effect.void)
    ),
    procedure(ElectronRpc.torrent.abortDownload, (id: string) =>
      run(downloads.get(id)?.cancel() ?? Effect.void)
    ),
    procedure(ElectronRpc.downloadTorrentInto, (link: string) =>
      run(
        Effect.tryPromise({
          try: () =>
            axios.get<ArrayBuffer>(link, { responseType: 'arraybuffer' }),
          catch: (cause: unknown) =>
            new HttpError({
              message: axios.isAxiosError(cause)
                ? cause.message
                : formatError(cause),
              statusCode: axios.isAxiosError(cause)
                ? (cause.response?.status ?? 0)
                : 0,
              url: link,
            }),
        }).pipe(Effect.map((response) => Buffer.from(response.data)))
      )
    ),
    procedure(
      ElectronRpc.getTorrentHash,
      (item: string | Buffer | Uint8Array) => run(getTorrentInfoHash(item))
    )
  );
}
