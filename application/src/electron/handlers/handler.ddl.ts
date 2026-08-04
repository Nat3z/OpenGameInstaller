import {
  ConfigError,
  ConnectionRefreshRequested,
  DownloadAborted,
  DownloadError,
  DownloadNotActive,
  FileSystemError,
  formatError,
  runEffectBoundary,
  TooManyRequests,
} from '@ogi/errors';
import axios, { AxiosError, type AxiosResponse } from 'axios';
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Scope,
  Stream,
} from 'effect';
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import { rm as rmAsync } from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import { dirname } from 'path';
import { Readable, Transform, type TransformCallback } from 'stream';
import { getEffectiveOnlineState } from '@/electron/lib/online.js';
import { sendNotification } from '@/electron/main.js';
import {
  getStoredValue,
  refreshCached,
} from '@/electron/manager/manager.config.js';
import { DOWNLOAD_QUEUE } from '@/electron/manager/manager.queue.js';
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

// Parallel download configuration
const PARALLEL_DOWNLOAD_THRESHOLD = 100 * 1024 * 1024; // 100MB in bytes
let PARALLEL_CHUNK_COUNT: number = 0;

// Bandwidth throttling
let BANDWIDTH_LIMIT_BYTES_PER_SEC: number = 0;

const CONNECTION_HEALTH_SAMPLE_INTERVAL_MS = 2000;
const CONNECTION_HEALTH_WINDOW_SIZE = 12;
const CONNECTION_HEALTH_MIN_TRANSFER_BYTES = 5 * 1024 * 1024;
const CONNECTION_HEALTH_MIN_POSITIVE_SAMPLES = 4;
const CONNECTION_HEALTH_LOW_SPEED_RATIO = 0.2;
const CONNECTION_HEALTH_NEAR_ZERO_BYTES_PER_SEC = 64 * 1024;
const CONNECTION_HEALTH_DECLINE_RATIO = 0.6;
const CONNECTION_HEALTH_PERSISTENCE_MS = 12000;
const CONNECTION_HEALTH_MAX_RECOVERIES = 2;
const CONNECTION_HEALTH_RECONNECT_COOLDOWN_MS = 15000;

class GlobalTokenBucket {
  private tokens: number;
  private lastRefillTime: number = Date.now();

  constructor(private bytesPerSec: number) {
    this.tokens = bytesPerSec;
  }

  update(bytesPerSec: number) {
    this.bytesPerSec = bytesPerSec;
    if (this.tokens > bytesPerSec) this.tokens = bytesPerSec;
  }

  consume(bytes: number): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (this.bytesPerSec === 0) return;
      const now = Date.now();
      const elapsed = (now - this.lastRefillTime) / 1000;
      this.lastRefillTime = now;
      this.tokens = Math.min(
        this.bytesPerSec,
        this.tokens + elapsed * this.bytesPerSec
      );
      this.tokens -= bytes;
      if (this.tokens < 0) {
        const waitMs = (-this.tokens / this.bytesPerSec) * 1000;
        yield* Effect.sleep(`${waitMs} millis`);
      }
    });
  }
}

const globalTokenBucket = new GlobalTokenBucket(0);

class ThrottleStream extends Transform {
  constructor(private readonly runEffect: DownloadEffectRunner) {
    super();
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
    if (this.destroyed) {
      callback();
      return;
    }
    this.runEffect(
      globalTokenBucket.consume(chunk.length).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!this.destroyed) this.push(chunk);
          })
        ),
        Effect.ensuring(Effect.sync(callback))
      )
    );
  }
}

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
  parallelLimit?: number; // Upper limit from OGI-Parallel-Limit header if set
}

interface PartState {
  index: number;
  job: DownloadJob;
  status: 'pending' | 'downloading' | 'completed' | 'failed' | 'merging';
  downloadedBytes: number;
  totalBytes: number;
  abortController: AbortController;
  fileStream?: fs.WriteStream;
  response?: AxiosResponse<Readable>;
  // For chunk-based parallel within this part
  useChunks: boolean;
  chunks: ChunkState[];
  chunkJobPath: string;
  parallelLimit?: number; // Parsed OGI-Parallel-Limit for this part, if known
  effectiveChunkCount?: number; // Effective chunk count considering parallel limit
}

interface ConnectionHealthSnapshot {
  baselineSpeed: number;
  currentSpeed: number;
  previousSpeed: number;
}

interface ConnectionHealthMonitor {
  observe(totalBytes: number): void;
  readonly run: Effect.Effect<never>;
}

type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

type DownloadEffectRunner = <E>(
  effect: Effect.Effect<void, E>
) => Promise<unknown>;

interface DownloadLifecycle {
  readonly runEffect: DownloadEffectRunner;
  readonly onStatusChange: () => void;
  readonly onTerminal: (id: string) => void;
}

const standaloneDownloadLifecycle: DownloadLifecycle = {
  runEffect: (effect) =>
    runEffectBoundary(
      effect.pipe(
        Effect.catchAll((error) =>
          Effect.sync(() =>
            console.error('[download] Lifecycle failed:', error)
          )
        )
      )
    ),
  onStatusChange: () => {},
  onTerminal: () => {},
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getHeaderValue(
  headers: Record<string, unknown> | undefined,
  headerName: string
): string | undefined {
  if (!headers) return undefined;
  const lowerHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerHeaderName) continue;
    if (Array.isArray(value)) return String(value[0]);
    if (value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

function parseParallelLimitHeader(
  headers: Record<string, unknown> | undefined
): number | undefined {
  const rawLimit = getHeaderValue(headers, 'OGI-Parallel-Limit');
  if (!rawLimit) return undefined;
  const limit = parseInt(rawLimit, 10);
  return Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

function mergeParallelLimits(
  ...limits: Array<number | undefined>
): number | undefined {
  const validLimits = limits.filter(
    (limit): limit is number => typeof limit === 'number' && limit > 0
  );
  return validLimits.length > 0 ? Math.min(...validLimits) : undefined;
}

function calculateBaselineSpeed(samples: number[]): number {
  const positiveSamples = samples
    .filter((sample) => sample > 0)
    .sort((a, b) => b - a);
  if (positiveSamples.length === 0) return 0;

  const baselineSampleCount = Math.max(
    3,
    Math.ceil(positiveSamples.length / 3)
  );
  return average(positiveSamples.slice(0, baselineSampleCount));
}

export class Download {
  public id: string;
  private _status: DownloadStatus = 'queued';

  public get status(): DownloadStatus {
    return this._status;
  }

  public set status(newStatus: DownloadStatus) {
    this._status = newStatus;
    this.lifecycle.onStatusChange();
  }

  private mainWindow: BrowserWindow;
  private jobs: DownloadJob[];
  private totalParts: number;
  private currentPart: number = 0;
  private taskFinisher: () => void = () => {};

  private response?: AxiosResponse<Readable>;
  private fileStream?: fs.WriteStream;
  private abortController?: AbortController;

  private currentBytes: number = 0;
  private totalSize: number = 0;
  private startByte: number = 0;
  private startTime: number = 0;

  // Parallel download state (for single-file chunk parallelization)
  private useParallel: boolean = false;
  private chunks: ChunkState[] = [];
  private parallelTotalSize: number = 0;
  private parallelLimit?: number;
  private effectiveChunkCount?: number;
  private currentJobPath: string = ''; // Track current job path for chunk file cleanup

  // Multi-part parallel download state
  private useParallelParts: boolean = false;
  private parts: PartState[] = [];
  private multiPartTotalBytes: number = 0;
  private multiPartStartTime: number = 0;

  constructor(
    mainWindow: BrowserWindow,
    jobs: DownloadJob[],
    startPart: number = 1,
    private readonly lifecycle: DownloadLifecycle = standaloneDownloadLifecycle
  ) {
    this.id = Math.random().toString(36).substring(7);
    this.mainWindow = mainWindow;
    this.jobs = jobs;
    this.totalParts = jobs.length;
    this.currentPart = startPart || 1;

    registerDownloadHandshake(this.id);
  }

  private observeParallelLimit(
    headers: Record<string, unknown> | undefined,
    part?: PartState
  ): void {
    const observedLimit = parseParallelLimitHeader(headers);
    if (observedLimit === undefined) return;

    this.parallelLimit = mergeParallelLimits(this.parallelLimit, observedLimit);
    if (part) {
      part.parallelLimit = mergeParallelLimits(
        part.parallelLimit,
        observedLimit
      );
    }
  }

  private reportHandshake(
    update: Partial<DownloadHandshakeResult> = {},
    terminalEvent?: { channel: string; data: unknown }
  ) {
    const status =
      update.status ??
      (this.status === 'failed'
        ? 'error'
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

  public waitForReady(): Effect.Effect<DownloadHandshakeResult, DownloadError> {
    return Effect.tryPromise({
      try: () => waitForDownloadHandshake(this.id),
      catch: (cause) =>
        new DownloadError({
          message: formatError(cause),
          downloadId: this.id,
          cause,
        }),
    });
  }

  private classifyDownloadRequestError(
    message: string,
    cause: unknown,
    connectionRefreshRequested = false
  ): DownloadError | ConnectionRefreshRequested | DownloadAborted {
    if (axios.isCancel(cause)) {
      return connectionRefreshRequested
        ? new ConnectionRefreshRequested({ downloadId: this.id })
        : new DownloadAborted({ downloadId: this.id });
    }

    return new DownloadError({
      message: `${message}: ${formatError(cause)}`,
      downloadId: this.id,
      cause,
    });
  }

  private createConnectionHealthMonitor(options: {
    label: string;
    initialBytes: number;
    onReconnect: (snapshot: ConnectionHealthSnapshot) => void;
  }): ConnectionHealthMonitor {
    let observedBytes = options.initialBytes;
    let lastObservedBytes = options.initialBytes;
    let lastObservedAt = Date.now();
    let lowSpeedSince: number | undefined;
    let reconnectAttempts = 0;
    let lastReconnectAt = 0;
    const samples: number[] = [];

    const sample = Effect.sync(() => {
      const now = Date.now();
      const elapsedMs = now - lastObservedAt;
      if (elapsedMs <= 0) return;

      const bytesDelta = Math.max(0, observedBytes - lastObservedBytes);
      const speed = (bytesDelta * 1000) / elapsedMs;

      lastObservedBytes = observedBytes;
      lastObservedAt = now;

      samples.push(speed);
      if (samples.length > CONNECTION_HEALTH_WINDOW_SIZE) {
        samples.shift();
      }

      const transferredBytes = observedBytes - options.initialBytes;
      if (transferredBytes < CONNECTION_HEALTH_MIN_TRANSFER_BYTES) {
        lowSpeedSince = undefined;
        return;
      }

      const positiveSamples = samples.filter((current) => current > 0);
      if (positiveSamples.length < CONNECTION_HEALTH_MIN_POSITIVE_SAMPLES)
        return;

      const baselineSpeed = calculateBaselineSpeed(samples);
      if (baselineSpeed <= 0) return;

      const currentWindow = samples.slice(-3);
      const previousWindow = samples.slice(-6, -3);
      const currentSpeed = average(currentWindow);
      const previousSpeed =
        previousWindow.length > 0 ? average(previousWindow) : baselineSpeed;
      const lowRelativeSpeed =
        currentSpeed <= baselineSpeed * CONNECTION_HEALTH_LOW_SPEED_RATIO;
      const trendingTowardZero =
        currentSpeed <= CONNECTION_HEALTH_NEAR_ZERO_BYTES_PER_SEC ||
        (previousSpeed > 0 &&
          currentSpeed <= previousSpeed * CONNECTION_HEALTH_DECLINE_RATIO);

      lowSpeedSince =
        lowRelativeSpeed && trendingTowardZero
          ? (lowSpeedSince ?? now)
          : undefined;
      if (!lowSpeedSince) return;
      if (!getEffectiveOnlineState().effectiveOnline) {
        lowSpeedSince = undefined;
        return;
      }

      const inCooldown =
        now - lastReconnectAt < CONNECTION_HEALTH_RECONNECT_COOLDOWN_MS;
      const slowLongEnough =
        now - lowSpeedSince >= CONNECTION_HEALTH_PERSISTENCE_MS;
      if (
        reconnectAttempts >= CONNECTION_HEALTH_MAX_RECOVERIES ||
        inCooldown ||
        !slowLongEnough
      ) {
        return;
      }

      reconnectAttempts++;
      lastReconnectAt = now;
      lowSpeedSince = undefined;
      console.log(
        `[direct] ${options.label}: throughput collapsed, recycling connection ` +
          `(current=${(currentSpeed / (1024 * 1024)).toFixed(2)}MB/s, ` +
          `baseline=${(baselineSpeed / (1024 * 1024)).toFixed(2)}MB/s)`
      );
      options.onReconnect({ baselineSpeed, currentSpeed, previousSpeed });
    });

    return {
      observe(totalBytes: number) {
        observedBytes = totalBytes;
      },
      run: Effect.sleep(`${CONNECTION_HEALTH_SAMPLE_INTERVAL_MS} millis`).pipe(
        Effect.zipRight(sample),
        Effect.forever
      ),
    };
  }

  public start(): Effect.Effect<void, DownloadError> {
    return Effect.gen(this, function* () {
      const { wait, finish, cancelHandler } = DOWNLOAD_QUEUE.enqueue(this.id, {
        type: 'direct',
      });
      this.taskFinisher = finish;

      cancelHandler((cancel) => {
        registerQueueCancel(this.id, () => {
          cancel();
          return this.lifecycle.runEffect(this.cancel());
        });
      });

      const result = yield* wait((queuePosition) => {
        console.log('queuePosition', queuePosition);
        this.sendProgress({ queuePosition });
        this.reportHandshake({ status: 'queued', queuePosition });
      });

      if (result === 'cancelled') {
        this.removeCancelHandler();
        this.reportHandshake({ status: 'error', error: 'Download cancelled' });
        clearDownloadHandshake(this.id);
        this.lifecycle.onTerminal(this.id);
        return;
      }

      console.log('[direct] Starting download...');
      yield* this.run();
    });
  }

  private removeCancelHandler() {
    removeQueueCancel(this.id);
  }

  private run(): Effect.Effect<void> {
    this.status = 'downloading';
    this.reportHandshake({ status: 'downloading' });
    return Effect.gen(this, function* () {
      if (this.totalParts > 1) {
        yield* this.runParallelParts();
      } else {
        this.currentPart = 1;
        const job = this.jobs[0];
        console.log('[direct] Downloading single part');
        yield* this.downloadPart(job);
        console.log('[direct] Completed downloading single part');
      }
      console.log('[direct] Completed downloading all parts');
      yield* this.complete();
    }).pipe(
      Effect.catchAll((error) =>
        ['paused', 'cancelled'].includes(this.status)
          ? Effect.void
          : this.fail(
              error instanceof Error
                ? error
                : new DownloadError({
                    message: formatError(error),
                    downloadId: this.id,
                    cause: error,
                  })
            )
      )
    );
  }

  /**
   * Run parallel downloads for multi-part downloads.
   * Downloads up to PARALLEL_CHUNK_COUNT parts simultaneously.
   */
  private runParallelParts(): Effect.Effect<
    void,
    DownloadError | DownloadNotActive | DownloadAborted
  > {
    return Effect.gen(this, function* () {
      this.useParallelParts = true;

      // Only re-initialize parts if they don't exist (first run, not resume)
      if (this.parts.length === 0) {
        this.parts = [];
      }

      console.log(
        `[direct] Starting parallel multi-part download with ${this.totalParts} parts`
      );

      // Initialize part states - check existing files for resume
      for (let i = 0; i < this.totalParts; i++) {
        // Skip if part already exists in array (resume scenario)
        const existingPart = this.parts.find((p) => p.index === i);
        if (existingPart) {
          // Reset status if it was downloading when paused
          if (existingPart.status === 'downloading') {
            existingPart.status = 'pending';
          }
          continue;
        }

        const job = this.jobs[i];
        let downloadedBytes = 0;
        let isComplete = false;

        // Check if part file exists for resume
        let totalBytes = 0;
        let knownPartParallelLimit = parseParallelLimitHeader(job.headers);
        const existingSize = yield* Effect.try({
          try: () =>
            fs.existsSync(job.path) ? fs.statSync(job.path).size : undefined,
          catch: (cause) =>
            new FileSystemError({
              message: `Could not inspect part ${i + 1}: ${formatError(cause)}`,
              path: job.path,
              cause,
            }),
        }).pipe(
          Effect.catchTag('FileSystemError', (error) =>
            Effect.sync(() => {
              console.log(error.message);
              return undefined;
            })
          )
        );
        if (existingSize !== undefined) {
          downloadedBytes = existingSize;
          console.log(
            `[direct] Part ${i + 1} file exists with ${downloadedBytes} bytes`
          );

          const parallelInfo =
            yield* this.shouldUseParallelDownloadForPart(job);
          totalBytes = parallelInfo.fileSize;
          knownPartParallelLimit = mergeParallelLimits(
            knownPartParallelLimit,
            parallelInfo.parallelLimit
          );

          if (parallelInfo.fileSize > 0) {
            // For chunked downloads, check if merged file exists and is correct size
            if (parallelInfo.useParallel) {
              // Check if all chunk files exist and merged file is correct size
              // Use stored effectiveChunkCount if available, otherwise calculate
              const effectiveChunkCount =
                mergeParallelLimits(
                  PARALLEL_CHUNK_COUNT,
                  parseParallelLimitHeader(job.headers),
                  parallelInfo.parallelLimit
                ) ?? PARALLEL_CHUNK_COUNT;
              const allChunksExist = yield* Effect.try({
                try: () =>
                  Array.from({ length: effectiveChunkCount }, (_, idx) =>
                    fs.existsSync(this.getChunkPath(job.path, idx))
                  ).every(Boolean),
                catch: (cause) =>
                  new FileSystemError({
                    message: `Could not inspect chunks: ${formatError(cause)}`,
                    path: job.path,
                    cause,
                  }),
              }).pipe(
                Effect.catchTag('FileSystemError', (error) =>
                  Effect.sync(() => {
                    console.log(error.message);
                    return false;
                  })
                )
              );

              if (allChunksExist && downloadedBytes >= parallelInfo.fileSize) {
                isComplete = true;
                downloadedBytes = parallelInfo.fileSize; // Ensure it matches expected
              }
            } else {
              // Standard download - check if file size matches expected
              if (downloadedBytes >= parallelInfo.fileSize) {
                isComplete = true;
                downloadedBytes = parallelInfo.fileSize; // Ensure it matches expected
              }
            }
          }
        }

        this.parts.push({
          index: i,
          job,
          status: isComplete ? 'completed' : 'pending',
          downloadedBytes,
          totalBytes: totalBytes || 0, // Set if we got it from HEAD request
          abortController: new AbortController(),
          useChunks: false,
          chunks: [],
          chunkJobPath: '',
          parallelLimit: knownPartParallelLimit,
          effectiveChunkCount: undefined,
        });

        if (isComplete) {
          console.log(`[direct] Part ${i + 1} already complete, skipping`);
        }
      }

      // Update total bytes for progress calculation
      this.updateMultiPartTotalBytes();

      this.multiPartStartTime = Date.now();
      yield* Effect.forkScoped(this.trackMultiPartProgress());

      // Process parts in batches
      const unfinishedParts = () =>
        this.parts.filter(
          (p) =>
            p.status === 'pending' ||
            p.status === 'downloading' ||
            p.status === 'merging'
        );
      const activeParts = () =>
        this.parts.filter((p) => p.status === 'downloading');
      const activeRequestCount = () =>
        activeParts().reduce((count, part) => {
          if (!part.useChunks || part.chunks.length === 0) {
            return count + 1;
          }
          return count + part.chunks.filter((chunk) => !chunk.completed).length;
        }, 0);
      const completedParts = () =>
        this.parts.filter((p) => p.status === 'completed');

      while (unfinishedParts().length > 0) {
        if (this.status !== 'downloading') {
          return yield* Effect.fail(
            new DownloadNotActive({ downloadId: this.id })
          );
        }

        // Start new parts if we have capacity. Respect OGI-Parallel-Limit as a
        // total connection cap for concurrent parts.
        const knownParallelLimits = this.parts.map((part) =>
          mergeParallelLimits(
            part.parallelLimit,
            parseParallelLimitHeader(part.job.headers)
          )
        );
        const effectivePartLimit = mergeParallelLimits(
          PARALLEL_CHUNK_COUNT,
          this.parallelLimit,
          ...knownParallelLimits
        );
        const availableSlots = Math.max(
          0,
          (effectivePartLimit ?? PARALLEL_CHUNK_COUNT) - activeRequestCount()
        );
        // Start one part at a time so chunk fan-out cannot briefly exceed the
        // parallel limit while multiple parts are still in HEAD/setup.
        const partsToStart =
          availableSlots > 0
            ? this.parts.filter((p) => p.status === 'pending').slice(0, 1)
            : [];

        if (partsToStart.length > 0) {
          console.log(
            `[direct] Starting ${partsToStart.length} parts (${activeParts().length} active, ${completedParts().length} completed)`
          );

          // Start downloads without waiting
          for (const part of partsToStart) {
            part.status = 'downloading';
            yield* Effect.forkScoped(
              this.downloadPartWithState(part).pipe(
                Effect.catchAll((error) =>
                  Effect.sync(() => {
                    if (this.status === 'downloading') {
                      console.error(
                        `[direct] Part ${part.index + 1} failed:`,
                        error
                      );
                      part.status = 'failed';
                    }
                  })
                )
              )
            );
          }
        }

        // Wait a bit before checking again
        yield* Effect.sleep('100 millis');

        // Check if all parts are done
        if (
          this.parts.every(
            (p) => p.status === 'completed' || p.status === 'failed'
          )
        ) {
          break;
        }
      }

      // Check for any failed parts
      const failedParts = this.parts.filter((p) => p.status === 'failed');
      if (failedParts.length > 0) {
        return yield* Effect.fail(
          new DownloadError({
            message: `${failedParts.length} parts failed to download`,
            downloadId: this.id,
          })
        );
      }

      console.log('[direct] All parallel parts completed');
    }).pipe(Effect.scoped);
  }

  /**
   * Download a single part with optional chunk parallelization.
   * Used by runParallelParts() for multi-part downloads.
   */
  private downloadPartWithState(
    part: PartState,
    retries = 5
  ): Effect.Effect<
    void,
    | DownloadError
    | DownloadNotActive
    | TooManyRequests
    | FileSystemError
    | ConnectionRefreshRequested
    | DownloadAborted
  > {
    return Effect.gen(this, function* () {
      const job = part.job;
      let lastError:
        | DownloadError
        | DownloadNotActive
        | TooManyRequests
        | FileSystemError
        | ConnectionRefreshRequested
        | DownloadAborted
        | undefined;

      // Check if this part should use chunk parallelization
      const parallelInfo = yield* this.shouldUseParallelDownloadForPart(
        job,
        part.abortController.signal
      );
      part.totalBytes = parallelInfo.fileSize;
      part.parallelLimit = mergeParallelLimits(
        part.parallelLimit,
        parallelInfo.parallelLimit
      );
      part.effectiveChunkCount =
        mergeParallelLimits(PARALLEL_CHUNK_COUNT, part.parallelLimit) ??
        PARALLEL_CHUNK_COUNT;

      // Update total bytes for progress calculation
      this.updateMultiPartTotalBytes();

      if (parallelInfo.useParallel) {
        console.log(
          `[direct] Part ${part.index + 1}: Using chunk parallelization (${(parallelInfo.fileSize / (1024 * 1024)).toFixed(2)}MB)`
        );
        part.useChunks = true;
        part.chunkJobPath = job.path;

        for (let i = 0; i < retries; i++) {
          if (this.status !== 'downloading') {
            return yield* Effect.fail(
              new DownloadNotActive({ downloadId: this.id })
            );
          }
          part.status = 'downloading';
          const attempt = yield* Effect.either(
            this.executeParallelDownloadForPart(part, parallelInfo.fileSize)
          );
          if (attempt._tag === 'Right') {
            part.status = 'completed';
            console.log(`[direct] Part ${part.index + 1} completed (chunked)`);
            return;
          }
          lastError = attempt.left;
          if (
            lastError._tag !== 'DownloadAborted' &&
            lastError._tag !== 'ConnectionRefreshRequested'
          ) {
            console.log(
              `[direct] Part ${part.index + 1} chunk download attempt ${i} failed:`,
              lastError
            );
          }
          if (this.status !== 'downloading') {
            return yield* Effect.fail(lastError);
          }
          if (lastError._tag === 'ConnectionRefreshRequested') continue;

          const failedChunkCount = part.effectiveChunkCount;
          const nextChunkCount =
            mergeParallelLimits(PARALLEL_CHUNK_COUNT, part.parallelLimit) ??
            PARALLEL_CHUNK_COUNT;
          // A failed attempt may have learned a stricter response limit. Its
          // partial files use the old byte partition and cannot be resumed
          // safely with the new count. Clear the whole failed layout even when
          // the count is unchanged so corrupt chunks cannot poison every retry.
          yield* this.deleteChunkFiles(
            part.job.path,
            Math.max(failedChunkCount ?? 0, nextChunkCount)
          );
          part.chunks = [];
          part.effectiveChunkCount = nextChunkCount;
          if (lastError instanceof TooManyRequests) {
            console.log(
              `[direct] Part ${part.index + 1}: 429 detected, disabling chunk parallelization and retrying as standard download`
            );
            part.useChunks = false;
            yield* this.deleteChunkFiles(
              part.job.path,
              part.effectiveChunkCount
            );
            break;
          }
          yield* Effect.sleep(`${1000 * (i + 1)} millis`);
        }

        // If we broke out due to 429, continue to standard download
        if (
          lastError instanceof TooManyRequests ||
          lastError?.message === '429_TOO_MANY_REQUESTS'
        ) {
          // Reset lastError so we can try standard download
          lastError = undefined;
        } else {
          part.status = 'failed';
          return yield* Effect.fail(
            lastError ??
              new DownloadError({
                message: 'Parallel part download failed',
                downloadId: this.id,
              })
          );
        }
      }

      // Standard download for this part
      for (let i = 0; i < retries; i++) {
        if (this.status !== 'downloading') {
          return yield* Effect.fail(
            new DownloadNotActive({ downloadId: this.id })
          );
        }
        console.log(`[direct] Part ${part.index + 1}: Standard download`);
        const attempt = yield* Effect.either(this.executePartDownload(part));
        if (attempt._tag === 'Right') {
          part.status = 'completed';
          console.log(`[direct] Part ${part.index + 1} completed`);
          return;
        }
        lastError = attempt.left;

        if (
          lastError._tag !== 'DownloadAborted' &&
          lastError._tag !== 'ConnectionRefreshRequested'
        ) {
          console.log(
            `[direct] Part ${part.index + 1} download attempt ${i} failed:`,
            lastError
          );
        }
        if (this.status !== 'downloading') {
          return yield* Effect.fail(lastError);
        }
        if (lastError._tag === 'ConnectionRefreshRequested') {
          part.abortController = new AbortController();
          continue;
        }
        yield* Effect.sleep(`${1000 * (i + 1)} millis`);
      }
      part.status = 'failed';
      return yield* Effect.fail(
        lastError ??
          new DownloadError({
            message: 'Part download failed',
            downloadId: this.id,
          })
      );
    });
  }

  /**
   * Check if parallel download should be used for a part in multi-part download.
   */
  private shouldUseParallelDownloadForPart(
    job: DownloadJob,
    signal?: AbortSignal
  ): Effect.Effect<ParallelDownloadInfo, DownloadAborted> {
    return Effect.gen(this, function* () {
      const keepAliveAgent = job.link.startsWith('https')
        ? new https.Agent({ keepAlive: true })
        : new http.Agent({ keepAlive: true });

      const headResponse = yield* Effect.tryPromise({
        try: () =>
          axios.head(job.link, {
            headers: {
              ...job.headers,
              'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
            },
            httpAgent: keepAliveAgent,
            httpsAgent: keepAliveAgent,
            timeout: 10000,
            signal,
          }),
        catch: (cause) =>
          axios.isCancel(cause)
            ? new DownloadAborted({ downloadId: this.id })
            : new DownloadError({
                message: `HEAD request failed: ${formatError(cause)}`,
                downloadId: this.id,
                cause,
              }),
      });

      const contentLength = headResponse.headers['content-length']
        ? parseInt(String(headResponse.headers['content-length']), 10)
        : 0;
      const supportsRange = headResponse.headers['accept-ranges'] === 'bytes';
      let parallelLimit = mergeParallelLimits(
        parseParallelLimitHeader(job.headers),
        parseParallelLimitHeader(headResponse.headers)
      );

      // Some hosts only send OGI-Parallel-Limit on GET responses. Probe one
      // byte before chunk fan-out so that a GET-only cap is known before OGI
      // opens all ranged connections.
      if (
        supportsRange &&
        contentLength > PARALLEL_DOWNLOAD_THRESHOLD &&
        parallelLimit !== 1
      ) {
        const probeResult = yield* Effect.either(
          Effect.tryPromise({
            try: () =>
              axios.get<Readable>(job.link, {
                responseType: 'stream',
                headers: {
                  ...job.headers,
                  'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
                  'Accept-Encoding': 'identity',
                  Range: 'bytes=0-0',
                },
                httpAgent: keepAliveAgent,
                httpsAgent: keepAliveAgent,
                timeout: 10000,
                signal,
              }),
            catch: (cause) =>
              axios.isCancel(cause)
                ? new DownloadAborted({ downloadId: this.id })
                : new DownloadError({
                    message: `Parallel limit probe failed: ${formatError(cause)}`,
                    downloadId: this.id,
                    cause,
                  }),
          })
        );
        if (
          probeResult._tag === 'Left' &&
          probeResult.left._tag === 'DownloadAborted'
        ) {
          return yield* Effect.fail(probeResult.left);
        }
        if (probeResult._tag === 'Right') {
          parallelLimit = mergeParallelLimits(
            parallelLimit,
            parseParallelLimitHeader(probeResult.right.headers)
          );
          probeResult.right.data.destroy();
        }
      }

      return {
        useParallel:
          supportsRange &&
          contentLength > PARALLEL_DOWNLOAD_THRESHOLD &&
          parallelLimit !== 1,
        fileSize: contentLength,
        supportsRange,
        parallelLimit,
      };
    }).pipe(
      Effect.catchTag('DownloadError', (error) =>
        Effect.sync(() => {
          console.log(
            '[direct] HEAD request failed for part, falling back to standard:',
            error
          );
          return {
            useParallel: false,
            fileSize: 0,
            supportsRange: false,
          };
        })
      )
    );
  }

  /**
   * Execute a parallel (chunked) download for a part.
   */
  private executeParallelDownloadForPart(
    part: PartState,
    fileSize: number
  ): Effect.Effect<
    void,
    | DownloadError
    | TooManyRequests
    | FileSystemError
    | ConnectionRefreshRequested
    | DownloadAborted
  > {
    return Effect.gen(this, function* () {
      const job = part.job;
      part.chunks = [];

      const effectiveChunkCount =
        part.effectiveChunkCount ?? PARALLEL_CHUNK_COUNT;

      // Store effective chunk count in part state for later use
      part.effectiveChunkCount = effectiveChunkCount;

      const chunkSize = Math.ceil(fileSize / effectiveChunkCount);
      fs.mkdirSync(dirname(job.path), { recursive: true });

      // Initialize chunks for this part
      for (let i = 0; i < effectiveChunkCount; i++) {
        const startByte = i * chunkSize;
        const endByte = Math.min((i + 1) * chunkSize - 1, fileSize - 1);
        const expectedChunkSize = endByte - startByte + 1;
        const chunkPath = this.getChunkPath(job.path, i);

        let chunkCurrentBytes = 0;
        if (fs.existsSync(chunkPath)) {
          chunkCurrentBytes = fs.statSync(chunkPath).size;
          if (chunkCurrentBytes > expectedChunkSize) {
            fs.rmSync(chunkPath, { force: true });
            chunkCurrentBytes = 0;
          }
        }

        part.chunks.push({
          index: i,
          startByte,
          endByte,
          currentBytes: chunkCurrentBytes,
          abortController: new AbortController(),
          completed: chunkCurrentBytes === expectedChunkSize,
        });
      }

      part.downloadedBytes = part.chunks.reduce(
        (sum, chunk) => sum + chunk.currentBytes,
        0
      );

      let connectionRefreshRequested = false;
      const connectionHealth = this.createConnectionHealthMonitor({
        label: `Part ${part.index + 1}`,
        initialBytes: part.downloadedBytes,
        onReconnect: ({ currentSpeed, baselineSpeed }) => {
          if (connectionRefreshRequested || this.status !== 'downloading')
            return;
          connectionRefreshRequested = true;
          console.log(
            `[direct] Part ${part.index + 1}: restarting ranged chunk requests ` +
              `after slowdown (${(currentSpeed / (1024 * 1024)).toFixed(2)}MB/s of ` +
              `${(baselineSpeed / (1024 * 1024)).toFixed(2)}MB/s baseline)`
          );
          for (const activeChunk of part.chunks) {
            activeChunk.abortController.abort();
          }
        },
      });

      yield* Effect.forkScoped(connectionHealth.run);
      yield* Effect.all(
        part.chunks.map((chunk) =>
          this.downloadChunkForPart(
            part,
            chunk,
            () => connectionHealth.observe(part.downloadedBytes),
            () => connectionRefreshRequested
          )
        ),
        { concurrency: 'unbounded', discard: true }
      );

      // Mark only this part as merging (don't change global status)
      part.status = 'merging';
      this.sendProgress({ progress: this.currentBytes / this.totalSize });

      // Merge chunk files
      yield* this.mergeChunkFilesForPart(part);

      // Reset part status to downloading after merge completes
      part.status = 'downloading';

      // Update part's downloaded bytes
      part.downloadedBytes = fileSize;
    }).pipe(Effect.scoped);
  }

  /**
   * Download a single chunk for a part.
   */
  private downloadChunkForPart(
    part: PartState,
    chunk: ChunkState,
    onProgress?: () => void,
    isConnectionRefreshRequested: () => boolean = () => false
  ): Effect.Effect<
    void,
    | DownloadError
    | TooManyRequests
    | FileSystemError
    | ConnectionRefreshRequested
    | DownloadAborted
  > {
    return Effect.gen(this, function* () {
      if (chunk.completed) return;

      const actualStartByte = chunk.startByte + chunk.currentBytes;
      if (actualStartByte > chunk.endByte) {
        chunk.completed = true;
        return;
      }

      const chunkPath = this.getChunkPath(part.job.path, chunk.index);
      const keepAliveAgent = part.job.link.startsWith('https')
        ? new https.Agent({ keepAlive: true })
        : new http.Agent({ keepAlive: true });
      const request = Effect.tryPromise({
        try: () =>
          axios.get<Readable>(part.job.link, {
            responseType: 'stream',
            headers: {
              ...part.job.headers,
              'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
              'Accept-Encoding': 'identity',
              Range: `bytes=${actualStartByte}-${chunk.endByte}`,
            },
            httpAgent: keepAliveAgent,
            httpsAgent: keepAliveAgent,
            signal: chunk.abortController.signal,
          }),
        catch: (cause) =>
          this.classifyDownloadRequestError(
            'Chunk request failed',
            cause,
            isConnectionRefreshRequested()
          ),
      });
      const responseResult = yield* Effect.either(request);
      if (responseResult._tag === 'Left') {
        const requestError = responseResult.left;
        if (requestError._tag !== 'DownloadError') {
          return yield* Effect.fail(requestError);
        }
        const cause = requestError.cause;
        if (cause instanceof AxiosError) {
          this.observeParallelLimit(
            cause.response?.headers as Record<string, unknown> | undefined,
            part
          );
        }
        if (cause instanceof AxiosError && cause.response?.status === 416) {
          chunk.completed = true;
          return;
        }
        if (cause instanceof AxiosError && cause.response?.status === 429) {
          return yield* Effect.fail(new TooManyRequests({}));
        }
        return yield* Effect.fail(requestError);
      }
      chunk.response = responseResult.right;
      this.observeParallelLimit(chunk.response.headers, part);

      if (chunk.response.status === 429) {
        return yield* Effect.fail(new TooManyRequests({}));
      }
      if (chunk.response.status !== 206) {
        return yield* Effect.fail(
          new DownloadError({
            message: `Unexpected status ${chunk.response.status} for range request`,
            downloadId: this.id,
          })
        );
      }

      const stream = yield* Effect.try({
        try: () => {
          chunk.fileStream = fs.createWriteStream(chunkPath, {
            flags: chunk.currentBytes > 0 ? 'a' : 'w',
          });
          let throttle: ThrottleStream | undefined;
          if (BANDWIDTH_LIMIT_BYTES_PER_SEC > 0) {
            throttle = new ThrottleStream(this.lifecycle.runEffect);
            chunk.response!.data.pipe(throttle);
            throttle.pipe(chunk.fileStream);
          } else {
            chunk.response!.data.pipe(chunk.fileStream);
          }
          return { stream: chunk.fileStream, throttle };
        },
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to open chunk file: ${formatError(cause)}`,
            path: chunkPath,
            cause,
          }),
      });

      yield* Effect.async<
        void,
        DownloadError | ConnectionRefreshRequested | DownloadAborted
      >((resume) => {
        let resolved = false;
        stream.stream.on('finish', () => {
          if (resolved) return;
          resolved = true;
          chunk.completed = true;
          resume(Effect.void);
        });
        chunk.abortController.signal.addEventListener('abort', () => {
          if (resolved) return;
          resolved = true;
          stream.throttle?.destroy();
          chunk.fileStream?.close();
          chunk.fileStream = undefined;
          chunk.response = undefined;
          stream.stream.destroy();
          resume(
            Effect.fail(
              isConnectionRefreshRequested()
                ? new ConnectionRefreshRequested({ downloadId: this.id })
                : new DownloadAborted({ downloadId: this.id })
            )
          );
        });
        stream.stream.on('error', (cause) => {
          if (resolved) return;
          resolved = true;
          resume(
            Effect.fail(
              new DownloadError({
                message: `Chunk stream failed: ${formatError(cause)}`,
                downloadId: this.id,
                cause,
              })
            )
          );
        });
        chunk.response!.data.on('data', (data: Buffer) => {
          chunk.currentBytes += data.length;
          part.downloadedBytes = part.chunks.reduce(
            (sum, current) => sum + current.currentBytes,
            0
          );
          onProgress?.();
        });
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            stream.throttle?.destroy();
            chunk.response?.data.destroy();
            chunk.fileStream?.destroy();
            chunk.fileStream = undefined;
            chunk.response = undefined;
          })
        )
      );
    });
  }

  /**
   * Merge chunk files for a part.
   */
  private mergeChunkFilesForPart(
    part: PartState
  ): Effect.Effect<void, FileSystemError> {
    return Effect.gen(this, function* () {
      const effectiveChunkCount =
        part.effectiveChunkCount ?? PARALLEL_CHUNK_COUNT;
      yield* Effect.try({
        try: () => {
          if (part.chunks.length !== effectiveChunkCount) {
            throw new Error(
              `Expected ${effectiveChunkCount} chunks, found ${part.chunks.length}`
            );
          }
          for (let i = 0; i < effectiveChunkCount; i++) {
            const chunk = part.chunks[i];
            const chunkPath = this.getChunkPath(part.job.path, i);
            const expectedSize = chunk.endByte - chunk.startByte + 1;
            const actualSize = fs.statSync(chunkPath).size;
            if (actualSize !== expectedSize) {
              throw new Error(
                `Chunk ${i} has ${actualSize} bytes; expected ${expectedSize}`
              );
            }
          }
        },
        catch: (cause) =>
          new FileSystemError({
            message: `Cannot merge invalid chunks: ${formatError(cause)}`,
            path: part.job.path,
            cause,
          }),
      });

      const finalStream = yield* Effect.try({
        try: () => fs.createWriteStream(part.job.path, { flags: 'w' }),
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to create merged part: ${formatError(cause)}`,
            path: part.job.path,
            cause,
          }),
      });
      yield* Effect.async<void, FileSystemError>((resume) => {
        let resolved = false;
        let currentChunkIndex = 0;
        let activeChunkStream: fs.ReadStream | undefined;
        const fail = (cause: unknown, path = part.job.path) => {
          if (resolved) return;
          resolved = true;
          activeChunkStream?.destroy();
          activeChunkStream = undefined;
          resume(
            Effect.fail(
              new FileSystemError({
                message: `Failed to merge chunks: ${formatError(cause)}`,
                path,
                cause,
              })
            )
          );
        };
        const writeNextChunk = () => {
          if (resolved) return;
          if (currentChunkIndex >= effectiveChunkCount) {
            finalStream.end(() => {
              if (resolved) return;
              resolved = true;
              resume(Effect.void);
            });
            return;
          }
          const chunkPath = this.getChunkPath(part.job.path, currentChunkIndex);
          if (!fs.existsSync(chunkPath)) {
            fail(`Chunk file ${chunkPath} not found for merge`, chunkPath);
            return;
          }
          const chunkStream = fs.createReadStream(chunkPath);
          activeChunkStream = chunkStream;
          let ended = false;
          chunkStream.on('error', (cause) => {
            finalStream.destroy();
            fail(cause, chunkPath);
          });
          chunkStream.on('end', () => {
            ended = true;
            activeChunkStream = undefined;
            currentChunkIndex++;
            writeNextChunk();
          });
          chunkStream.on('close', () => {
            if (!ended && !resolved) {
              finalStream.destroy();
              fail('Chunk stream closed before reaching the end', chunkPath);
            }
          });
          chunkStream.pipe(finalStream, { end: false });
        };
        finalStream.on('error', fail);
        writeNextChunk();
        return Effect.sync(() => {
          if (resolved) return;
          resolved = true;
          activeChunkStream?.destroy();
          activeChunkStream = undefined;
          finalStream.destroy();
        });
      });
      yield* this.deleteChunkFiles(
        part.job.path,
        part.effectiveChunkCount
      ).pipe(Effect.ignore);
    });
  }

  /**
   * Execute a standard (non-chunked) download for a part.
   */
  private executePartDownload(
    part: PartState
  ): Effect.Effect<
    void,
    | DownloadError
    | FileSystemError
    | TooManyRequests
    | ConnectionRefreshRequested
    | DownloadAborted
  > {
    return Effect.gen(this, function* () {
      const job = part.job;
      let connectionRefreshRequested = false;

      const startByte = yield* Effect.try({
        try: () => {
          let existingBytes = 0;
          if (fs.existsSync(job.path)) {
            existingBytes = fs.statSync(job.path).size;
            part.downloadedBytes = existingBytes;
          }
          fs.mkdirSync(dirname(job.path), { recursive: true });
          if (fs.existsSync(job.path) && fs.statSync(job.path).isDirectory()) {
            return undefined;
          }
          part.fileStream = fs.createWriteStream(job.path, {
            flags: existingBytes > 0 ? 'r+' : 'w',
            start: existingBytes,
          });
          return existingBytes;
        },
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to prepare download part: ${formatError(cause)}`,
            path: job.path,
            cause,
          }),
      });
      if (startByte === undefined) {
        return yield* Effect.fail(
          new FileSystemError({
            message: `Cannot write to path: ${job.path} is a directory`,
            path: job.path,
          })
        );
      }

      const keepAliveAgent = job.link.startsWith('https')
        ? new https.Agent({ keepAlive: true })
        : new http.Agent({ keepAlive: true });
      const responseResult = yield* Effect.either(
        Effect.tryPromise({
          try: () =>
            axios.get<Readable>(job.link, {
              responseType: 'stream',
              headers: {
                ...job.headers,
                'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
                'Accept-Encoding': 'identity',
                ...(startByte > 0 && { Range: `bytes=${startByte}-` }),
              },
              httpAgent: keepAliveAgent,
              httpsAgent: keepAliveAgent,
              signal: part.abortController.signal,
            }),
          catch: (cause) =>
            this.classifyDownloadRequestError(
              'Part request failed',
              cause,
              connectionRefreshRequested
            ),
        })
      );
      if (responseResult._tag === 'Left') {
        const requestError = responseResult.left;
        part.fileStream?.destroy();
        part.fileStream = undefined;
        if (requestError._tag !== 'DownloadError') {
          return yield* Effect.fail(requestError);
        }
        const cause = requestError.cause;
        if (cause instanceof AxiosError) {
          this.observeParallelLimit(
            cause.response?.headers as Record<string, unknown> | undefined,
            part
          );
        }
        if (cause instanceof AxiosError && cause.response?.status === 416) {
          part.downloadedBytes = 0;
          yield* Effect.tryPromise({
            try: () => rmAsync(job.path, { force: true }),
            catch: (error) =>
              new FileSystemError({
                message: `Failed to reset download part: ${formatError(error)}`,
                path: job.path,
                cause: error,
              }),
          });
          return yield* this.executePartDownload(part);
        }
        if (cause instanceof AxiosError && cause.response?.status === 429) {
          return yield* Effect.fail(new TooManyRequests({}));
        }
        return yield* Effect.fail(requestError);
      }
      part.response = responseResult.right;
      this.observeParallelLimit(part.response.headers, part);

      if (startByte > 0 && part.response.status !== 206) {
        part.fileStream?.close();
        part.downloadedBytes = 0;
        yield* Effect.tryPromise({
          try: () => rmAsync(job.path, { force: true }),
          catch: (cause) =>
            new FileSystemError({
              message: `Failed to restart download part: ${formatError(cause)}`,
              path: job.path,
              cause,
            }),
        });
        return yield* this.executePartDownload(part);
      }

      const contentLength = part.response.headers['content-length']
        ? parseInt(String(part.response.headers['content-length']), 10)
        : 0;
      part.totalBytes = startByte + contentLength;
      this.updateMultiPartTotalBytes();
      const connectionHealth = this.createConnectionHealthMonitor({
        label: `Part ${part.index + 1}`,
        initialBytes: part.downloadedBytes,
        onReconnect: ({ currentSpeed, baselineSpeed }) => {
          if (connectionRefreshRequested || this.status !== 'downloading')
            return;
          connectionRefreshRequested = true;
          console.log(
            `[direct] Part ${part.index + 1}: restarting ranged stream after slowdown ` +
              `(${(currentSpeed / (1024 * 1024)).toFixed(2)}MB/s of ` +
              `${(baselineSpeed / (1024 * 1024)).toFixed(2)}MB/s baseline)`
          );
          part.abortController.abort();
        },
      });
      yield* Effect.forkScoped(connectionHealth.run);

      const stream = yield* Effect.try({
        try: () => {
          let throttle: ThrottleStream | undefined;
          if (BANDWIDTH_LIMIT_BYTES_PER_SEC > 0) {
            throttle = new ThrottleStream(this.lifecycle.runEffect);
            part.response!.data.pipe(throttle);
            throttle.pipe(part.fileStream!);
          } else {
            part.response!.data.pipe(part.fileStream!);
          }
          return { file: part.fileStream!, throttle };
        },
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to open part stream: ${formatError(cause)}`,
            path: job.path,
            cause,
          }),
      });

      yield* Effect.async<
        void,
        DownloadError | ConnectionRefreshRequested | DownloadAborted
      >((resume) => {
        let resolved = false;
        stream.file.on('finish', () => {
          if (resolved) return;
          resolved = true;
          part.fileStream?.close();
          part.fileStream = undefined;
          part.response = undefined;
          resume(Effect.void);
        });
        part.abortController.signal.addEventListener('abort', () => {
          if (resolved) return;
          resolved = true;
          stream.throttle?.destroy();
          part.fileStream?.close();
          part.fileStream = undefined;
          part.response = undefined;
          stream.file.destroy();
          resume(
            Effect.fail(
              connectionRefreshRequested
                ? new ConnectionRefreshRequested({ downloadId: this.id })
                : new DownloadAborted({ downloadId: this.id })
            )
          );
        });
        stream.file.on('error', (cause) => {
          if (resolved) return;
          resolved = true;
          part.fileStream?.close();
          part.fileStream = undefined;
          resume(
            Effect.fail(
              new DownloadError({
                message: `Part stream failed: ${formatError(cause)}`,
                downloadId: this.id,
                cause,
              })
            )
          );
        });
        part.response!.data.on('data', (data: Buffer) => {
          part.downloadedBytes += data.length;
          connectionHealth.observe(part.downloadedBytes);
        });
      });
    }).pipe(Effect.scoped);
  }

  /**
   * Update total bytes across all parts for progress calculation.
   */
  private updateMultiPartTotalBytes(): void {
    this.multiPartTotalBytes = this.parts.reduce(
      (sum, part) => sum + (part.totalBytes || 0),
      0
    );
  }

  public pause() {
    if (this.status !== 'downloading') return;

    this.status = 'paused';

    if (this.useParallelParts) {
      // Abort all active part downloads
      for (const part of this.parts) {
        if (part.status === 'downloading') {
          part.abortController.abort();
          if (part.fileStream) {
            part.fileStream.close();
            part.fileStream = undefined;
          }
          part.response = undefined;
          // Also abort any chunks for this part
          for (const chunk of part.chunks) {
            chunk.abortController.abort();
            if (chunk.fileStream) {
              chunk.fileStream.close();
              chunk.fileStream = undefined;
            }
            chunk.response = undefined;
          }
          part.status = 'pending'; // Reset to pending so it can resume
        }
      }
    } else if (this.useParallel) {
      // Abort all chunk downloads (single file)
      for (const chunk of this.chunks) {
        chunk.abortController.abort();
        if (chunk.fileStream) {
          chunk.fileStream.close();
          chunk.fileStream = undefined;
        }
        chunk.response = undefined;
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

    if (this.useParallelParts) {
      // Reset abort controllers for parts that need to resume
      for (const part of this.parts) {
        if (part.status === 'pending' || part.status === 'downloading') {
          part.abortController = new AbortController();
          for (const chunk of part.chunks) {
            chunk.abortController = new AbortController();
          }
        }
      }
      // Don't clear parts array - preserve state for resume
      // Just reset the flag so runParallelParts can continue
      this.useParallelParts = false;
    } else if (this.useParallel) {
      // Reset parallel state for single-file chunk download
      this.useParallel = false;
      for (const chunk of this.chunks) {
        chunk.abortController = new AbortController();
      }
      this.chunks = [];
    }

    this.sendIpc('ddl:download-resumed', { id: this.id });
  }

  public continue(): Effect.Effect<void> {
    return this.run();
  }

  public cancel(): Effect.Effect<void> {
    if (this.status === 'cancelled' || this.status === 'completed') {
      return Effect.void;
    }

    return Effect.gen(this, function* () {
      this.status = 'cancelled';
      if (this.useParallelParts) {
        for (const part of this.parts) {
          part.abortController.abort();
          part.fileStream?.destroy();
          part.fileStream = undefined;
          part.response?.data.destroy();
          part.response = undefined;
          for (const chunk of part.chunks) {
            chunk.abortController.abort();
            chunk.fileStream?.destroy();
            chunk.fileStream = undefined;
            chunk.response?.data.destroy();
            chunk.response = undefined;
          }
        }
      } else if (this.useParallel) {
        for (const chunk of this.chunks) chunk.abortController.abort();
        this.cleanupParallelChunks();
      } else {
        this.abortController?.abort();
        this.cleanupPart();
      }

      yield* this.cleanupAllFiles();
      this.removeCancelHandler();
      this.sendIpc('ddl:download-cancelled', { id: this.id });
      this.taskFinisher();
      clearDownloadHandshake(this.id);
      this.lifecycle.onTerminal(this.id);
      console.log('[direct] Download Cancelled', this.id);
    }).pipe(Effect.ignore);
  }

  private complete(): Effect.Effect<void> {
    return Effect.sync(() => {
      console.log('[direct] Download completed');
      // Keep status as 'downloading' (not 'completed') so the frontend does not
      // enter the addon setup phase before ddl:download-complete fires.
      // The frontend sets 'completed' when setup actually starts. This also clears
      // the temporary parallel chunk merge status before the completion event.
      this.status = 'downloading';

      // Clean up any remaining resources
      if (this.useParallelParts) {
        // Clean up multi-part parallel downloads
        for (const part of this.parts) {
          if (part.fileStream) {
            part.fileStream.close();
            part.fileStream = undefined;
          }
          part.response = undefined;
        }
      } else if (this.useParallel) {
        this.cleanupParallelChunks();
      } else {
        this.cleanupPart();
      }

      this.sendProgress({ progress: 1, downloadSpeed: 0 });
      const completePayload = { id: this.id };
      this.reportHandshake(
        { status: 'completed' },
        {
          channel: 'ddl:download-complete',
          data: completePayload,
        }
      );
      this.sendIpc('ddl:download-complete', completePayload);
      sendNotification({
        message: 'Download completed',
        id: this.id,
        type: 'success',
      });
      this.removeCancelHandler();
      this.taskFinisher();
      clearDownloadHandshake(this.id);
      this.lifecycle.onTerminal(this.id);
    });
  }

  private fail(error: Error): Effect.Effect<void> {
    this.status = 'failed';
    const errorPayload = { id: this.id, error: error.message };
    this.reportHandshake(
      { status: 'error', error: error.message },
      {
        channel: 'ddl:download-error',
        data: errorPayload,
      }
    );

    if (this.useParallelParts) {
      // Clean up multi-part parallel downloads
      for (const part of this.parts) {
        part.abortController.abort();
        if (part.fileStream) {
          part.fileStream.close();
          part.fileStream = undefined;
        }
        part.response = undefined;
        for (const chunk of part.chunks) {
          chunk.abortController.abort();
          if (chunk.fileStream) {
            chunk.fileStream.close();
            chunk.fileStream = undefined;
          }
          chunk.response = undefined;
        }
      }
    } else if (this.useParallel) {
      this.cleanupParallelChunks();
    } else {
      this.cleanupPart();
    }

    return this.cleanupAllFiles().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.sendIpc('ddl:download-error', errorPayload);
          sendNotification({
            message: 'Download failed',
            id: this.id,
            type: 'error',
          });
          this.removeCancelHandler();
          this.taskFinisher();
          clearDownloadHandshake(this.id);
          this.lifecycle.onTerminal(this.id);
        })
      ),
      Effect.ignore
    );
  }

  private downloadPart(
    job: DownloadJob,
    retries = 5
  ): Effect.Effect<
    void,
    | DownloadError
    | DownloadNotActive
    | TooManyRequests
    | FileSystemError
    | ConnectionRefreshRequested
    | DownloadAborted
  > {
    return Effect.gen(this, function* () {
      let lastError:
        | DownloadError
        | DownloadNotActive
        | TooManyRequests
        | FileSystemError
        | ConnectionRefreshRequested
        | DownloadAborted
        | undefined;

      // Check if we should use parallel download (only for single-part downloads)
      if (this.totalParts === 1) {
        this.abortController = new AbortController();
        const parallelInfo = yield* this.shouldUseParallelDownload(job);
        if (parallelInfo.useParallel) {
          console.log('[direct] Using parallel download');
          for (let i = 0; i < retries; i++) {
            if (this.status !== 'downloading')
              return yield* Effect.fail(
                new DownloadNotActive({ downloadId: this.id })
              );
            const attempt = yield* Effect.either(
              this.executeParallelDownload(job, parallelInfo.fileSize)
            );
            if (attempt._tag === 'Right') {
              console.log('[direct] Parallel download completed');
              return;
            }
            lastError = attempt.left;
            if (
              lastError._tag !== 'DownloadAborted' &&
              lastError._tag !== 'ConnectionRefreshRequested'
            ) {
              console.log(
                '[direct] Error in parallel download attempt',
                i,
                lastError
              );
            }
            if (this.status !== 'downloading') {
              return yield* Effect.fail(lastError);
            }
            if (lastError._tag === 'ConnectionRefreshRequested') continue;
            if (lastError instanceof TooManyRequests) {
              console.log(
                '[direct] 429 detected, disabling parallelization and retrying as standard download'
              );
              yield* this.deleteChunkFiles(job.path, this.effectiveChunkCount);
              break;
            }
            yield* Effect.sleep(`${1000 * (i + 1)} millis`);
          }

          // If we broke out due to 429, continue to standard download
          if (
            lastError instanceof TooManyRequests ||
            lastError?.message === '429_TOO_MANY_REQUESTS'
          ) {
            // Reset lastError so we can try standard download
            lastError = undefined;
          } else {
            return yield* Effect.fail(
              lastError ??
                new DownloadError({
                  message: 'Parallel download failed',
                  downloadId: this.id,
                })
            );
          }
        }
      }

      // Standard download
      for (let i = 0; i < retries; i++) {
        if (this.status !== 'downloading') {
          return yield* Effect.fail(
            new DownloadNotActive({ downloadId: this.id })
          );
        }
        console.log('[direct] Attempting to download part', this.currentPart);
        const attempt = yield* Effect.either(this._executeDownloadPart(job));
        if (attempt._tag === 'Right') {
          console.log('[direct] Download Completed of Part', this.currentPart);
          return;
        }
        lastError = attempt.left;
        if (
          lastError._tag !== 'DownloadAborted' &&
          lastError._tag !== 'ConnectionRefreshRequested'
        ) {
          console.log('[direct] Error downloading part', i, lastError);
        }
        if (this.status !== 'downloading') {
          return yield* Effect.fail(lastError);
        }
        if (lastError._tag === 'ConnectionRefreshRequested') continue;
        yield* Effect.sleep(`${1000 * (i + 1)} millis`);
      }
      return yield* Effect.fail(
        lastError ??
          new DownloadError({
            message: 'Download failed',
            downloadId: this.id,
          })
      );
    });
  }

  private _executeDownloadPart(
    job: DownloadJob
  ): Effect.Effect<
    void,
    | DownloadError
    | FileSystemError
    | TooManyRequests
    | ConnectionRefreshRequested
    | DownloadAborted
  > {
    return Effect.gen(this, function* () {
      this.sendProgress({ progress: 0, downloadSpeed: 0 });
      let connectionRefreshRequested = false;
      this.abortController = new AbortController();

      yield* Effect.try({
        try: () => {
          if (fs.existsSync(job.path)) {
            this.startByte = fs.statSync(job.path).size;
            console.log('[direct] Existing file found, size: ', this.startByte);
          } else {
            this.startByte = 0;
          }
          this.currentBytes = this.startByte;
          fs.mkdirSync(dirname(job.path), { recursive: true });
          if (fs.existsSync(job.path) && fs.statSync(job.path).isDirectory()) {
            return false;
          }
          this.fileStream = fs.createWriteStream(job.path, {
            flags: this.startByte > 0 ? 'r+' : 'w',
            start: this.startByte,
          });
          return true;
        },
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to prepare download: ${formatError(cause)}`,
            path: job.path,
            cause,
          }),
      }).pipe(
        Effect.flatMap((valid) =>
          valid
            ? Effect.void
            : Effect.fail(
                new FileSystemError({
                  message: `Cannot write to path: ${job.path} is a directory`,
                  path: job.path,
                })
              )
        )
      );

      const keepAliveAgent = job.link.startsWith('https')
        ? new https.Agent({ keepAlive: true })
        : new http.Agent({ keepAlive: true });
      const responseResult = yield* Effect.either(
        Effect.tryPromise({
          try: () =>
            axios.get<Readable>(job.link, {
              responseType: 'stream',
              headers: {
                ...job.headers,
                'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
                'Accept-Encoding': 'identity',
                ...(this.startByte > 0 && {
                  Range: `bytes=${this.startByte}-`,
                }),
              },
              httpAgent: keepAliveAgent,
              httpsAgent: keepAliveAgent,
              signal: this.abortController!.signal,
            }),
          catch: (cause) =>
            this.classifyDownloadRequestError(
              'Download request failed',
              cause,
              connectionRefreshRequested
            ),
        })
      );
      if (responseResult._tag === 'Left') {
        const requestError = responseResult.left;
        if (requestError._tag !== 'DownloadError') {
          this.cleanupPart();
          return yield* Effect.fail(requestError);
        }
        const cause = requestError.cause;
        if (cause instanceof AxiosError) {
          this.observeParallelLimit(
            cause.response?.headers as Record<string, unknown> | undefined
          );
        }
        if (cause instanceof AxiosError && cause.response?.status === 416) {
          this.startByte = 0;
          this.currentBytes = 0;
          this.fileStream?.close();
          yield* Effect.tryPromise({
            try: () => rmAsync(job.path, { force: true }),
            catch: (error) =>
              new FileSystemError({
                message: `Failed to reset download: ${formatError(error)}`,
                path: job.path,
                cause: error,
              }),
          });
          return yield* this._executeDownloadPart(job);
        }
        if (cause instanceof AxiosError && cause.response?.status === 404) {
          yield* this.cancel();
        }
        if (cause instanceof AxiosError && cause.response?.status === 429) {
          this.cleanupPart();
          return yield* Effect.fail(new TooManyRequests({}));
        }
        this.cleanupPart();
        return yield* Effect.fail(requestError);
      }
      this.response = responseResult.right;
      this.observeParallelLimit(this.response.headers);

      if (this.startByte > 0 && this.response.status !== 206) {
        this.startByte = 0;
        this.currentBytes = 0;
        this.fileStream?.close();
        yield* Effect.tryPromise({
          try: () => rmAsync(job.path, { force: true }),
          catch: (cause) =>
            new FileSystemError({
              message: `Failed to restart download: ${formatError(cause)}`,
              path: job.path,
              cause,
            }),
        });
        return yield* this._executeDownloadPart(job);
      }

      const contentLength = this.response.headers['content-length']
        ? parseInt(String(this.response.headers['content-length']), 10)
        : 0;
      this.totalSize = this.startByte + contentLength;
      this.startTime = Date.now();
      yield* Effect.forkScoped(this.trackProgress());
      const connectionHealth = this.createConnectionHealthMonitor({
        label: `Part ${this.currentPart}`,
        initialBytes: this.currentBytes,
        onReconnect: ({ currentSpeed, baselineSpeed }) => {
          if (
            connectionRefreshRequested ||
            !this.abortController ||
            this.status !== 'downloading'
          )
            return;
          connectionRefreshRequested = true;
          console.log(
            `[direct] Part ${this.currentPart}: restarting ranged stream after slowdown ` +
              `(${(currentSpeed / (1024 * 1024)).toFixed(2)}MB/s of ` +
              `${(baselineSpeed / (1024 * 1024)).toFixed(2)}MB/s baseline)`
          );
          this.abortController.abort();
        },
      });
      yield* Effect.forkScoped(connectionHealth.run);

      const stream = yield* Effect.try({
        try: () => {
          let throttle: ThrottleStream | undefined;
          if (BANDWIDTH_LIMIT_BYTES_PER_SEC > 0) {
            throttle = new ThrottleStream(this.lifecycle.runEffect);
            this.response!.data.pipe(throttle);
            throttle.pipe(this.fileStream!);
          } else {
            this.response!.data.pipe(this.fileStream!);
          }
          return { file: this.fileStream!, throttle };
        },
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to open download stream: ${formatError(cause)}`,
            path: job.path,
            cause,
          }),
      });

      yield* Effect.async<
        void,
        DownloadError | ConnectionRefreshRequested | DownloadAborted
      >((resume) => {
        let resolved = false;
        stream.file.on('finish', () => {
          if (resolved) return;
          resolved = true;
          this.cleanupPart();
          console.log(
            '[direct] Stream finished (Downloaded bytes:',
            `${(this.currentBytes / (1024 * 1024)).toFixed(2)} MB)`
          );
          resume(Effect.void);
        });
        this.abortController!.signal.addEventListener('abort', () => {
          if (resolved) return;
          resolved = true;
          stream.throttle?.destroy();
          this.cleanupPart();
          stream.file.destroy();
          resume(
            Effect.fail(
              connectionRefreshRequested
                ? new ConnectionRefreshRequested({ downloadId: this.id })
                : new DownloadAborted({ downloadId: this.id })
            )
          );
        });
        stream.file.on('error', (cause) => {
          if (resolved) return;
          resolved = true;
          this.cleanupPart();
          resume(
            Effect.fail(
              new DownloadError({
                message: `Download stream failed: ${formatError(cause)}`,
                downloadId: this.id,
                cause,
              })
            )
          );
        });
        this.response!.data.on('data', (chunk: Buffer) => {
          this.currentBytes += chunk.length;
          connectionHealth.observe(this.currentBytes);
        });
      });
    }).pipe(Effect.scoped);
  }

  private trackProgress(): Effect.Effect<never> {
    return Effect.sleep('500 millis').pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (this.useParallel) {
            const totalDownloaded = this.chunks.reduce(
              (sum, chunk) => sum + chunk.currentBytes,
              0
            );
            const elapsedTime = (Date.now() - this.startTime) / 1000;
            this.sendProgress({
              progress:
                this.parallelTotalSize > 0
                  ? totalDownloaded / this.parallelTotalSize
                  : 0,
              downloadSpeed:
                elapsedTime > 0 ? totalDownloaded / elapsedTime : 0,
            });
            return;
          }

          const elapsedTime = (Date.now() - this.startTime) / 1000;
          this.sendProgress({
            progress:
              this.totalSize > 0 ? this.currentBytes / this.totalSize : 0,
            downloadSpeed:
              elapsedTime > 0
                ? (this.currentBytes - this.startByte) / elapsedTime
                : 0,
          });
        })
      ),
      Effect.forever
    );
  }

  private trackMultiPartProgress(): Effect.Effect<never> {
    return Effect.sleep('500 millis').pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const totalDownloaded = this.parts.reduce(
            (sum, part) => sum + part.downloadedBytes,
            0
          );
          const elapsedTime = (Date.now() - this.multiPartStartTime) / 1000;
          const downloadingParts = this.parts.filter(
            (part) => part.status === 'downloading' || part.status === 'pending'
          );
          const completedParts = this.parts.filter(
            (part) => part.status === 'completed'
          );
          let currentPartNumber = 1;
          if (downloadingParts.length > 0) {
            currentPartNumber =
              Math.max(...downloadingParts.map((part) => part.index)) + 1;
          } else if (completedParts.length === this.totalParts) {
            currentPartNumber = this.totalParts;
          } else {
            const incompletePart = this.parts.find(
              (part) => part.status !== 'completed'
            );
            if (incompletePart) currentPartNumber = incompletePart.index + 1;
          }

          this.sendIpc('ddl:download-progress', {
            id: this.id,
            progress:
              this.multiPartTotalBytes > 0
                ? totalDownloaded / this.multiPartTotalBytes
                : 0,
            downloadSpeed: elapsedTime > 0 ? totalDownloaded / elapsedTime : 0,
            fileSize: this.multiPartTotalBytes,
            part: currentPartNumber,
            status: this.status,
            totalParts: this.totalParts,
            queuePosition: 1,
          });
        })
      ),
      Effect.forever
    );
  }

  /**
   * Check if parallel download should be used for this job.
   * Sends a HEAD request to get file size and check range support.
   */
  private shouldUseParallelDownload(
    job: DownloadJob
  ): Effect.Effect<ParallelDownloadInfo, DownloadAborted> {
    return Effect.gen(this, function* () {
      const info = yield* this.shouldUseParallelDownloadForPart(
        job,
        this.abortController?.signal
      );
      this.parallelLimit = mergeParallelLimits(
        this.parallelLimit,
        info.parallelLimit
      );
      const useParallel = info.useParallel && this.totalParts === 1;
      console.log(
        `[direct] Parallel check: size=${(info.fileSize / (1024 * 1024 * 1024)).toFixed(2)}GB, ` +
          `supportsRange=${info.supportsRange}, useParallel=${useParallel}, ` +
          `parallelLimit=${info.parallelLimit ?? 'none'}`
      );
      return { ...info, useParallel };
    });
  }

  /**
   * Execute a parallel download by splitting the file into chunks.
   * Each chunk downloads to a separate file, then merges at the end.
   */
  private executeParallelDownload(
    job: DownloadJob,
    fileSize: number
  ): Effect.Effect<
    void,
    | DownloadError
    | TooManyRequests
    | FileSystemError
    | ConnectionRefreshRequested
    | DownloadAborted
  > {
    return Effect.gen(this, function* () {
      this.useParallel = true;
      this.parallelTotalSize = fileSize;
      this.currentJobPath = job.path;
      this.chunks = [];

      const effectiveChunkCount =
        mergeParallelLimits(PARALLEL_CHUNK_COUNT, this.parallelLimit) ??
        PARALLEL_CHUNK_COUNT;
      this.effectiveChunkCount = effectiveChunkCount;

      // Calculate chunk sizes
      const chunkSize = Math.ceil(fileSize / effectiveChunkCount);

      // Create the target directory
      fs.mkdirSync(dirname(job.path), { recursive: true });

      // Initialize chunks - check each chunk file individually for resume
      for (let i = 0; i < effectiveChunkCount; i++) {
        const startByte = i * chunkSize;
        const endByte = Math.min((i + 1) * chunkSize - 1, fileSize - 1);
        const expectedChunkSize = endByte - startByte + 1;
        const chunkPath = this.getChunkPath(job.path, i);

        // Check if this chunk file exists and how much was downloaded
        let chunkCurrentBytes = 0;
        if (fs.existsSync(chunkPath)) {
          chunkCurrentBytes = fs.statSync(chunkPath).size;
          if (chunkCurrentBytes > expectedChunkSize) {
            fs.rmSync(chunkPath, { force: true });
            chunkCurrentBytes = 0;
          }
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
          completed: chunkCurrentBytes === expectedChunkSize,
        });
      }

      this.currentBytes = this.chunks.reduce(
        (sum, chunk) => sum + chunk.currentBytes,
        0
      );

      let connectionRefreshRequested = false;
      const connectionHealth = this.createConnectionHealthMonitor({
        label: `Part ${this.currentPart}`,
        initialBytes: this.currentBytes,
        onReconnect: ({ currentSpeed, baselineSpeed }) => {
          if (connectionRefreshRequested || this.status !== 'downloading')
            return;
          connectionRefreshRequested = true;
          console.log(
            `[direct] Part ${this.currentPart}: restarting ranged chunk requests ` +
              `after slowdown (${(currentSpeed / (1024 * 1024)).toFixed(2)}MB/s of ` +
              `${(baselineSpeed / (1024 * 1024)).toFixed(2)}MB/s baseline)`
          );
          for (const activeChunk of this.chunks) {
            activeChunk.abortController.abort();
          }
        },
      });

      this.startTime = Date.now();
      yield* Effect.forkScoped(this.trackProgress());

      console.log(
        `[direct] Starting parallel download with ${effectiveChunkCount} chunks ` +
          `(limit: ${this.parallelLimit ?? 'none'}), ` +
          `chunk size: ${(chunkSize / (1024 * 1024)).toFixed(2)}MB`
      );

      yield* Effect.forkScoped(connectionHealth.run);
      yield* Effect.all(
        this.chunks.map((chunk) =>
          this.downloadChunk(
            job,
            chunk,
            () => connectionHealth.observe(this.currentBytes),
            () => connectionRefreshRequested
          )
        ),
        { concurrency: 'unbounded', discard: true }
      ).pipe(
        Effect.tapError((error) => {
          const cleanup = Effect.sync(() => this.cleanupParallelChunks());
          const preserveChunks =
            error._tag === 'ConnectionRefreshRequested' ||
            (error._tag === 'DownloadAborted' && this.status === 'paused');
          return preserveChunks
            ? cleanup
            : cleanup.pipe(
                Effect.zipRight(
                  this.deleteChunkFiles(job.path, effectiveChunkCount)
                )
              );
        })
      );
      console.log('[direct] All parallel chunks completed');

      this.cleanupParallelChunks();

      // Set status to merging before merging chunk files
      this.status = 'merging';
      this.sendProgress({ progress: this.currentBytes / this.totalSize });

      // Merge all chunk files into the final file
      yield* this.mergeChunkFiles(job);
    }).pipe(Effect.scoped);
  }

  /**
   * Download a single chunk of the file to a separate chunk file.
   */
  private downloadChunk(
    job: DownloadJob,
    chunk: ChunkState,
    onProgress?: () => void,
    isConnectionRefreshRequested: () => boolean = () => false
  ): Effect.Effect<
    void,
    | DownloadError
    | TooManyRequests
    | FileSystemError
    | ConnectionRefreshRequested
    | DownloadAborted
  > {
    const part: PartState = {
      index: this.currentPart - 1,
      job,
      status: 'downloading',
      downloadedBytes: this.currentBytes,
      totalBytes: this.parallelTotalSize,
      abortController: chunk.abortController,
      useChunks: true,
      chunks: this.chunks,
      chunkJobPath: job.path,
    };
    return this.downloadChunkForPart(
      part,
      chunk,
      () => {
        this.currentBytes = part.downloadedBytes;
        onProgress?.();
      },
      isConnectionRefreshRequested
    );
  }

  /**
   * Clean up all parallel chunk resources.
   */
  private cleanupParallelChunks() {
    for (const chunk of this.chunks) {
      chunk.response?.data.destroy();
      chunk.fileStream?.destroy();
      chunk.fileStream = undefined;
      chunk.response = undefined;
    }
  }

  /**
   * Merge all chunk files into the final file and delete chunk files.
   */
  private mergeChunkFiles(
    job: DownloadJob
  ): Effect.Effect<void, FileSystemError> {
    console.log('[direct] Merging chunk files into final file...');
    const part: PartState = {
      index: this.currentPart - 1,
      job,
      status: 'merging',
      downloadedBytes: this.currentBytes,
      totalBytes: this.parallelTotalSize,
      abortController: new AbortController(),
      useChunks: true,
      chunks: this.chunks,
      chunkJobPath: job.path,
      effectiveChunkCount:
        this.effectiveChunkCount ??
        (this.chunks.length > 0 ? this.chunks.length : PARALLEL_CHUNK_COUNT),
    };
    return this.mergeChunkFilesForPart(part).pipe(
      Effect.tap(() =>
        Effect.sync(() => console.log('[direct] Merge complete'))
      )
    );
  }

  /** Delete all chunk files for a job. */
  private deleteChunkFiles(
    basePath: string,
    effectiveChunkCount?: number
  ): Effect.Effect<void> {
    const count = effectiveChunkCount ?? PARALLEL_CHUNK_COUNT;
    return Effect.forEach(
      Array.from({ length: count }, (_, index) =>
        this.getChunkPath(basePath, index)
      ),
      (chunkPath) =>
        Effect.tryPromise({
          try: () => rmAsync(chunkPath, { force: true }),
          catch: (cause) =>
            new FileSystemError({
              message: `Failed to delete chunk file: ${formatError(cause)}`,
              path: chunkPath,
              cause,
            }),
        }).pipe(
          Effect.catchTag('FileSystemError', (error) =>
            Effect.sync(() => console.error(error.message))
          )
        ),
      { concurrency: 'unbounded', discard: true }
    );
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
      queuePosition: data.queuePosition ?? 1,
    });
  }

  private cleanupPart() {
    this.response?.data.destroy();
    this.fileStream?.destroy();
    this.response = undefined;
    this.fileStream = undefined;
    this.abortController = undefined;
  }

  private cleanupAllFiles(): Effect.Effect<void> {
    const paths = this.jobs.map((job) => job.path);
    if (this.currentJobPath) {
      const effectiveChunkCount =
        this.effectiveChunkCount ?? PARALLEL_CHUNK_COUNT;
      for (let i = 0; i < effectiveChunkCount; i++) {
        paths.push(this.getChunkPath(this.currentJobPath, i));
      }
    }
    if (this.useParallelParts || this.parts.length > 0) {
      for (const part of this.parts) {
        if (!part.useChunks) continue;
        const effectiveChunkCount =
          part.effectiveChunkCount ?? PARALLEL_CHUNK_COUNT;
        for (let i = 0; i < effectiveChunkCount; i++) {
          paths.push(this.getChunkPath(part.job.path, i));
        }
      }
    }
    return Effect.forEach(
      paths,
      (path) =>
        Effect.tryPromise({
          try: () => rmAsync(path, { force: true }),
          catch: (cause) =>
            new FileSystemError({
              message: `Failed to delete ${path}: ${formatError(cause)}`,
              path,
              cause,
            }),
        }).pipe(
          Effect.catchTag('FileSystemError', (error) =>
            Effect.sync(() => console.error(error.message))
          )
        ),
      { concurrency: 'unbounded', discard: true }
    );
  }

  private sendIpc(channel: string, data: Record<string, unknown>) {
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

function checkParallelChunkCount(
  activeDownloads: Iterable<Download>
): Effect.Effect<void, ConfigError> {
  return Effect.gen(function* () {
    yield* refreshCached('general');
    const val = Number(yield* getStoredValue('general', 'parallelChunkCount'));
    // Ensure minimum of 1, default to 8 if invalid
    const chunkCount = Math.max(1, Number.isFinite(val) ? val : 8);
    console.log('[direct] parallel chunk count:', chunkCount);

    // Coerce to safe positive integer, ensuring minimum of 1
    const oldChunkCount = PARALLEL_CHUNK_COUNT;
    PARALLEL_CHUNK_COUNT = chunkCount;

    if (oldChunkCount > 0 && oldChunkCount !== chunkCount) {
      console.log(
        '[direct] mismatched parallel chunk counts, will kill all downloads'
      );
      yield* Effect.forEach(activeDownloads, (download) => download.cancel(), {
        concurrency: 'unbounded',
        discard: true,
      });
    }

    const bwVal = Number(yield* getStoredValue('general', 'bandwidthLimit'));
    BANDWIDTH_LIMIT_BYTES_PER_SEC =
      Number.isFinite(bwVal) && bwVal > 0 ? Math.round(bwVal * 1024 * 1024) : 0;
    globalTokenBucket.update(BANDWIDTH_LIMIT_BYTES_PER_SEC);
    console.log(
      '[direct] bandwidth limit (bytes/s):',
      BANDWIDTH_LIMIT_BYTES_PER_SEC
    );
  });
}

interface ActiveDownload {
  readonly download: Download;
  readonly operationLock: Effect.Semaphore;
  fiber?: Fiber.RuntimeFiber<void, DownloadError>;
}

interface DownloadServiceShape {
  readonly start: (
    jobs: DownloadJob[],
    part?: number
  ) => Effect.Effect<unknown, DownloadError>;
  readonly pause: (id: string) => Effect.Effect<void, DownloadNotActive>;
  readonly resume: (
    id: string
  ) => Effect.Effect<void, DownloadError | DownloadNotActive>;
  readonly abort: (id: string) => Effect.Effect<void, DownloadNotActive>;
  readonly statuses: Stream.Stream<
    ReadonlyArray<{ id: string; status: DownloadStatus }>
  >;
  readonly shutdown: Effect.Effect<void>;
}

export class DownloadService extends Context.Tag('DownloadService')<
  DownloadService,
  DownloadServiceShape
>() {}

const makeDownloadService = (
  mainWindow: BrowserWindow
): Effect.Effect<DownloadServiceShape> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const activeDownloads = new Map<string, ActiveDownload>();
    const downloads = () =>
      Array.from(activeDownloads.values(), ({ download }) => download);
    const runInScope: DownloadEffectRunner = (effect) =>
      runEffectBoundary(
        Effect.forkIn(effect, scope).pipe(Effect.flatMap(Fiber.join))
      );
    const snapshot = () =>
      Array.from(activeDownloads, ([id, { download }]) => ({
        id,
        status: download.status,
      }));

    const service: DownloadServiceShape = {
      start: (jobs, part) =>
        Effect.gen(function* () {
          yield* checkParallelChunkCount(downloads()).pipe(
            Effect.mapError(
              (cause) => new DownloadError({ message: cause.message, cause })
            )
          );
          const download = new Download(mainWindow, jobs, part, {
            runEffect: runInScope,
            onStatusChange: () => {},
            onTerminal: (id) => activeDownloads.delete(id),
          });
          const active: ActiveDownload = {
            download,
            operationLock: Effect.unsafeMakeSemaphore(1),
          };
          activeDownloads.set(download.id, active);
          active.fiber = yield* Effect.forkIn(download.start(), scope);
          return yield* download.waitForReady();
        }),
      pause: (id) => {
        const active = activeDownloads.get(id);
        if (!active) {
          return Effect.fail(new DownloadNotActive({ downloadId: id }));
        }
        return active.operationLock.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* Effect.sync(() => active.download.pause());
              if (active.fiber) yield* Fiber.interrupt(active.fiber);
            })
          )
        );
      },
      resume: (id) => {
        const active = activeDownloads.get(id);
        if (!active) {
          return Effect.fail(new DownloadNotActive({ downloadId: id }));
        }
        return active.operationLock.withPermits(1)(
          Effect.gen(function* () {
            const { download } = active;
            if (download.status !== 'paused') return;

            yield* checkParallelChunkCount(downloads()).pipe(
              Effect.mapError(
                (cause) =>
                  new DownloadError({
                    message: cause.message,
                    downloadId: id,
                    cause,
                  })
              )
            );

            yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                if (download.status !== 'paused') return;
                yield* Effect.sync(() => download.resume());
                const fiber = yield* Effect.forkIn(
                  restore(download.continue()),
                  scope
                );
                active.fiber = fiber;
              })
            );
          })
        );
      },
      abort: (id) => {
        const active = activeDownloads.get(id);
        if (!active) {
          return Effect.fail(new DownloadNotActive({ downloadId: id }));
        }
        return active.operationLock.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* active.download.cancel();
              if (active.fiber) yield* Fiber.interrupt(active.fiber);
            })
          )
        );
      },
      statuses: Stream.repeatEffect(Effect.sync(snapshot)).pipe(
        Stream.schedule(Schedule.spaced('1 second'))
      ),
      shutdown: Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from(activeDownloads.values()),
          ({ download }) => download.cancel(),
          { concurrency: 'unbounded', discard: true }
        );
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.ignore),
    };

    return service;
  });

export const DownloadServiceLive = (
  mainWindow: BrowserWindow
): Layer.Layer<DownloadService> =>
  Layer.scoped(
    DownloadService,
    makeDownloadService(mainWindow).pipe(
      Effect.tap((service) => Effect.addFinalizer(() => service.shutdown))
    )
  );

export default function handler(mainWindow: BrowserWindow) {
  const service = Effect.runSync(makeDownloadService(mainWindow));
  const layer = Layer.succeed(DownloadService, service);
  const run = <A, E>(effect: Effect.Effect<A, E, DownloadService>) =>
    runEffectBoundary(effect.pipe(Effect.provide(layer)));

  mainWindow.once('closed', () => {
    void runEffectBoundary(service.shutdown);
  });

  return router(
    procedure(ElectronRpc.ddl.download, (jobs: DownloadJob[], part?: number) =>
      run(
        Effect.gen(function* () {
          return yield* (yield* DownloadService).start(jobs, part);
        })
      )
    ),
    procedure(ElectronRpc.ddl.pauseDownload, (id: string) =>
      run(
        Effect.gen(function* () {
          yield* (yield* DownloadService).pause(id);
        })
      )
    ),
    procedure(ElectronRpc.ddl.resumeDownload, (id: string) =>
      run(
        Effect.gen(function* () {
          yield* (yield* DownloadService).resume(id);
        })
      )
    ),
    procedure(ElectronRpc.ddl.abortDownload, (id: string) =>
      run(
        Effect.gen(function* () {
          yield* (yield* DownloadService).abort(id);
        })
      )
    )
  );
}
