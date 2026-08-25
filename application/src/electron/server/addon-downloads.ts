import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AddonServer } from '@ogi-sdk/addon-server';
import type {
  AddonDownloadAck,
  AddonDownloadRequest,
  AddonDownloadStatus,
  AddonDownloadStatusUpdate,
} from '@ogi-sdk/connect';
import { formatError, runEffectBoundary } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Cause, Effect } from 'effect';
import type { BrowserWindow } from 'electron';
import type {
  DownloadJob,
  DownloadServiceShape,
  DownloadStatus,
} from '@/electron/handlers/handler.ddl.js';
import { loadLibraryInfo } from '@/electron/handlers/helpers.app/library.js';
import {
  getStoredValue,
  refreshCached,
} from '@/electron/manager/manager.config.js';
import { cancelQueuedDownload } from '@/electron/rpc/queue-cancel.js';
import { consumeDownloadReplayEvents } from '@/lib/download-handshake.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

export type AddonDownloadCardPayload = {
  id: string;
  addonSource: string;
  name: string;
  appID: number;
  capsuleImage: string;
  coverImage: string;
  storefront: string;
  downloadPath: string;
  files: { path: string }[];
  queuePosition: number;
  totalParts: number;
};

type AddonDownloadContext = {
  service: DownloadServiceShape;
  mainWindow: BrowserWindow;
};

type PendingRequest = { disconnected: boolean };

let context: AddonDownloadContext | undefined;
const ownedDownloads = new Map<string, Set<string>>();

export function setAddonDownloadContext(
  service: DownloadServiceShape,
  mainWindow: BrowserWindow
): void {
  context = { service, mainWindow };
}

function sanitizePathSegment(segment: string): string {
  let result = segment.replace(/[/\\]+/g, '/');
  let previous: string;
  do {
    previous = result;
    result = result.replace(/\.\./g, '');
  } while (result !== previous);

  const parts = result
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..');
  const last = parts[parts.length - 1] ?? 'download';
  return last.replace(/[\0<>:"|?*]/g, '_').substring(0, 255) || 'download';
}

function resolveRelativeDownloadPath(
  baseDir: string,
  filePath: string
): string {
  if (isAbsolute(filePath)) return filePath;
  const segments = filePath
    .split(/[/\\]+/)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(sanitizePathSegment);
  return resolve(baseDir, ...(segments.length > 0 ? segments : ['download']));
}

function validateRequest(request: AddonDownloadRequest): string | undefined {
  if (!request || !Array.isArray(request.files) || request.files.length === 0) {
    return 'download request must include at least one file';
  }

  for (const file of request.files) {
    if (!file || typeof file.path !== 'string') {
      return 'download file path is invalid';
    }
    try {
      const url = new URL(file.link);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'download links must use http(s)';
      }
    } catch {
      return 'download links must use http(s)';
    }
  }
  return undefined;
}

function replyWith(
  reply: (ack: AddonDownloadAck) => void | Promise<void>,
  ack: AddonDownloadAck
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => Promise.resolve(reply(ack)),
    catch: (cause) => cause,
  }).pipe(
    Effect.tapError((error) =>
      logger.error('[addon-download] Failed to reply:', error)
    ),
    Effect.ignore
  );
}

function sendStatus(
  server: AddonServer,
  addonID: string,
  update: AddonDownloadStatusUpdate
): void {
  void runEffectBoundary(server.sendDownloadStatus(addonID, update));
}

function untrackDownload(addonID: string, downloadID: string): void {
  const owned = ownedDownloads.get(addonID);
  owned?.delete(downloadID);
  if (owned?.size === 0) ownedDownloads.delete(addonID);
}

// Route through the queue-cancel handler (same path as UI cancel) so
// queued-but-not-processing downloads are removed from the queue instead
// of being stranded by a direct service abort.
function cancelDownload(downloadID: string): Promise<void> {
  return cancelQueuedDownload(downloadID).catch((error) =>
    logger.sync.error('[addon-download] Failed to abort download:', error)
  );
}

function abortOwnedDownload(addonID: string, downloadID: string): void {
  if (!ownedDownloads.get(addonID)?.has(downloadID)) return;
  void cancelDownload(downloadID);
}

function handleDownloadRequest(
  server: AddonServer,
  addonID: string,
  request: AddonDownloadRequest,
  reply: (ack: AddonDownloadAck) => void | Promise<void>,
  pendingRequest: PendingRequest,
  onSettled: () => void
): void {
  const activeContext = context;
  if (!activeContext) {
    void runEffectBoundary(
      replyWith(reply, { error: 'download service unavailable' }).pipe(
        Effect.ensuring(Effect.sync(onSettled))
      )
    );
    return;
  }

  const validationError = validateRequest(request);
  if (validationError) {
    void runEffectBoundary(
      replyWith(reply, { error: validationError }).pipe(
        Effect.ensuring(Effect.sync(onSettled))
      )
    );
    return;
  }

  let downloadID: string | undefined;
  let ackDelivered = false;
  const pendingUpdates: Array<(id: string) => AddonDownloadStatusUpdate> = [];
  const emitStatus = (
    make: (id: string) => AddonDownloadStatusUpdate
  ): void => {
    if (ackDelivered && downloadID) {
      sendStatus(server, addonID, make(downloadID));
    } else {
      pendingUpdates.push(make);
    }
  };
  let lastStatus: AddonDownloadStatus | undefined;
  // Terminal renderer events (download-complete/error) also buffer in the
  // handshake replay map; frontend services normally consume them after
  // creating their card. Addon cards are created by our push instead, so we
  // drain the buffer ourselves: forward events that raced ahead of the card
  // push, drop ones the renderer already received directly.
  let cardAnnounced = false;
  const drainReplayEvents = (id: string, forward: boolean): void => {
    const events = consumeDownloadReplayEvents(id);
    if (!forward || activeContext.mainWindow.isDestroyed()) return;
    for (const event of events) {
      activeContext.mainWindow.webContents.send(event.channel, event.data);
    }
  };
  const sendDedupedStatus = (
    status: AddonDownloadStatus,
    error?: string
  ): void => {
    if (lastStatus === status) return;
    lastStatus = status;
    emitStatus((id) => ({ id, kind: 'status', status, error }));
  };
  const mapStatus = (
    status: DownloadStatus
  ): 'queued' | 'downloading' | 'paused' | undefined => {
    if (status === 'queued' || status === 'paused') return status;
    if (status === 'downloading' || status === 'merging') return 'downloading';
    return undefined;
  };

  const operation = Effect.gen(function* () {
    yield* refreshCached('general');
    const configuredLocation: unknown = yield* getStoredValue(
      'general',
      'fileDownloadLocation'
    );
    const configuredDir =
      typeof configuredLocation === 'string' && configuredLocation.length > 0
        ? configuredLocation
        : './downloads';
    const baseDir = resolve(process.cwd(), configuredDir);
    const prepared = yield* Effect.try({
      try: () => ({
        jobs: request.files.map(
          (file): DownloadJob => ({
            link: file.link,
            path: resolveRelativeDownloadPath(baseDir, file.path),
            headers: file.headers,
          })
        ),
        library: request.appID ? loadLibraryInfo(request.appID) : null,
      }),
      catch: (cause) => cause,
    });
    const { jobs, library } = prepared;
    yield* Effect.tryPromise({
      try: () =>
        Promise.all(
          jobs.map((job) => mkdir(dirname(job.path), { recursive: true }))
        ),
      catch: (cause) => cause,
    });

    if (pendingRequest.disconnected) {
      yield* replyWith(reply, { error: 'addon disconnected' });
      pendingUpdates.length = 0;
      return;
    }

    const handshake = yield* activeContext.service.start(jobs, undefined, {
      preservePartialFilesOnCancel: true,
      onProgress: (progress) => {
        emitStatus((id) => ({
          id,
          kind: 'progress',
          progress: progress.progress,
          downloadSpeed: progress.downloadSpeed,
          queuePosition: progress.queuePosition,
          part: progress.part,
          totalParts: progress.totalParts,
        }));
      },
      onStatusChange: (status) => {
        const addonStatus = mapStatus(status);
        if (addonStatus) sendDedupedStatus(addonStatus);
      },
      onTerminal: (id, outcome, error) => {
        const terminalStatus: AddonDownloadStatus =
          outcome === 'completed'
            ? 'completed'
            : outcome === 'failed'
              ? 'error'
              : 'cancelled';
        sendDedupedStatus(terminalStatus, error);
        untrackDownload(addonID, id);
        // Card already live: renderer got the terminal IPC directly, so the
        // buffered copy is stale. Pre-card terminals stay buffered for the
        // card push to forward.
        if (cardAnnounced) drainReplayEvents(id, false);
      },
    });

    downloadID = handshake.id;
    if (pendingRequest.disconnected) {
      yield* Effect.promise(() => cancelDownload(handshake.id));
      yield* replyWith(reply, { error: 'addon disconnected' });
      pendingUpdates.length = 0;
      drainReplayEvents(handshake.id, false);
      return;
    }
    if (handshake.status === 'error') {
      // Usually a no-op (the download already cleaned itself up), but a
      // handshake timeout can report an error while the queued fiber is
      // still alive — cancel so it isn't stranded without a handle.
      yield* Effect.promise(() => cancelDownload(handshake.id));
      yield* replyWith(reply, {
        error: handshake.error ?? 'download failed to start',
      });
      pendingUpdates.length = 0;
      drainReplayEvents(handshake.id, false);
      return;
    }
    if (handshake.queuePosition === undefined) {
      yield* Effect.promise(() => cancelDownload(handshake.id));
      yield* replyWith(reply, { error: 'download queue position unavailable' });
      pendingUpdates.length = 0;
      drainReplayEvents(handshake.id, false);
      return;
    }

    if (handshake.status !== 'completed') {
      const owned = ownedDownloads.get(addonID) ?? new Set<string>();
      owned.add(handshake.id);
      ownedDownloads.set(addonID, owned);
    }
    if (handshake.status === 'queued' || handshake.status === 'downloading') {
      sendDedupedStatus(handshake.status);
    }

    const payload: AddonDownloadCardPayload = {
      id: handshake.id,
      addonSource: addonID,
      name: request.name,
      appID: request.appID ?? 0,
      capsuleImage: request.capsuleImage ?? library?.capsuleImage ?? '',
      coverImage: library?.coverImage ?? '',
      storefront: library?.storefront ?? '',
      downloadPath: jobs[0].path,
      files: jobs.map(({ path }) => ({ path })),
      queuePosition: handshake.queuePosition,
      totalParts: jobs.length,
    };
    if (!activeContext.mainWindow.isDestroyed()) {
      activeContext.mainWindow.webContents.send(
        'ddl:addon-download-created',
        payload
      );
    }
    cardAnnounced = true;
    drainReplayEvents(handshake.id, true);
    yield* replyWith(reply, {
      id: handshake.id,
      queuePosition: handshake.queuePosition,
    });
    ackDelivered = true;
    for (const make of pendingUpdates) {
      sendStatus(server, addonID, make(handshake.id));
    }
    pendingUpdates.length = 0;
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        pendingUpdates.length = 0;
      }).pipe(
        Effect.zipRight(
          replyWith(reply, { error: formatError(Cause.squash(cause)) })
        )
      )
    ),
    Effect.ensuring(Effect.sync(onSettled))
  );

  void runEffectBoundary(operation);
}

export function attachAddonDownloadBridge(server: AddonServer): void {
  const pendingRequests = new Map<string, Set<PendingRequest>>();
  server.on('download-request', (addonID, request, reply) => {
    const pendingRequest: PendingRequest = { disconnected: false };
    const addonRequests = pendingRequests.get(addonID) ?? new Set();
    addonRequests.add(pendingRequest);
    pendingRequests.set(addonID, addonRequests);
    handleDownloadRequest(
      server,
      addonID,
      request,
      reply,
      pendingRequest,
      () => {
        addonRequests.delete(pendingRequest);
        if (
          addonRequests.size === 0 &&
          pendingRequests.get(addonID) === addonRequests
        ) {
          pendingRequests.delete(addonID);
        }
      }
    );
  });
  server.on('download-action', (addonID, downloadID, action) => {
    if (action === 'abort') abortOwnedDownload(addonID, downloadID);
  });
  server.on('addon-disconnect', (addonID) => {
    for (const pendingRequest of pendingRequests.get(addonID) ?? []) {
      pendingRequest.disconnected = true;
    }
    pendingRequests.delete(addonID);
    const downloads = Array.from(ownedDownloads.get(addonID) ?? []);
    for (const downloadID of downloads) {
      abortOwnedDownload(addonID, downloadID);
    }
    ownedDownloads.delete(addonID);
  });
}
