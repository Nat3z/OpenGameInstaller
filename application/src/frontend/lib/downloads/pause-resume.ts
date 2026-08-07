import { DownloadError, formatError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Deferred, Effect } from 'effect';
import { get } from 'svelte/store';
import { runDetached } from '@/frontend/lib/core/runtime';
import {
  getDownloadItem,
  updateDownloadStatus,
} from '@/frontend/lib/downloads/lifecycle';
import {
  deleteDownloadedItems,
  deletePersistedDownload,
} from '@/frontend/lib/downloads/persistence';
import {
  type PausedDownloadState,
  restartDownload,
} from '@/frontend/lib/downloads/restart';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import { startRedistributableInstallation } from '@/frontend/lib/setup/setup';
import {
  createNotification,
  currentDownloads,
  type DownloadStatusAndInfo,
  redistributableInstalls,
} from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

const pausedDownloadStates = new Map<string, PausedDownloadState>();
let hasBulkQueuedRestoredDownloads = false;
let bulkQueueRunning = false;
let bulkQueueDeferred: Deferred.Deferred<void> | null = null;
const resumeInFlight = new Set<string>();

function pausedStateFor(download: DownloadStatusAndInfo): PausedDownloadState {
  const downloadURL =
    download.downloadType === 'torrent' || download.downloadType === 'magnet'
      ? download.downloadURL
      : undefined;
  return {
    id: download.id,
    downloadInfo: { ...download },
    pausedAt: Date.now(),
    originalDownloadURL: download.originalDownloadURL || downloadURL,
    files: download.downloadType === 'direct' ? download.files : undefined,
  };
}

function backendAction(
  download: DownloadStatusAndInfo,
  action: 'pause' | 'resume'
) {
  const operation =
    download.downloadType === 'direct' || download.usedDebridService
      ? action === 'pause'
        ? electronRpc.ddl.pauseDownload(download.id)
        : electronRpc.ddl.resumeDownload(download.id)
      : download.downloadType === 'torrent' ||
          download.downloadType === 'magnet'
        ? action === 'pause'
          ? electronRpc.torrent.pauseDownload(download.id)
          : electronRpc.torrent.resumeDownload(download.id)
        : undefined;

  return operation
    ? operation.pipe(
        Effect.mapError(
          (cause) =>
            new DownloadError({
              message: `Failed to ${action} download: ${formatError(cause)}`,
              downloadId: download.id,
              cause,
            })
        ),
        Effect.as(true)
      )
    : Effect.succeed(false);
}

function enqueueRemainingPausedDownloads(resumedId: string) {
  let ownsQueue = false;
  let completion: Deferred.Deferred<void> | null = null;

  return Effect.gen(function* () {
    if (hasBulkQueuedRestoredDownloads) return;
    if (bulkQueueRunning && bulkQueueDeferred) {
      yield* Deferred.await(bulkQueueDeferred);
      return;
    }
    if (hasBulkQueuedRestoredDownloads) return;

    completion = yield* Deferred.make<void>();
    bulkQueueRunning = true;
    bulkQueueDeferred = completion;
    ownsQueue = true;
    const downloads = get(currentDownloads).filter(
      (download) => download.id !== resumedId && download.status === 'paused'
    );
    for (const download of downloads) {
      const latest = getDownloadItem(download.id);
      if (!latest || latest.status !== 'paused') continue;
      const state = pausedStateFor(latest);
      const hasFiles =
        latest.downloadType === 'direct' && !!latest.files?.length;
      if (!state.originalDownloadURL && !hasFiles) continue;
      pausedDownloadStates.set(latest.id, state);
      yield* restartDownload(state, pausedDownloadStates);
    }
    hasBulkQueuedRestoredDownloads = true;
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (!ownsQueue || !completion) return;
        bulkQueueRunning = false;
        bulkQueueDeferred = null;
        yield* Deferred.succeed(completion, undefined);
      })
    )
  );
}

export function pauseDownload(downloadId: string) {
  return Effect.gen(function* () {
    const download = getDownloadItem(downloadId);
    if (!download) return false;

    const pausedState = pausedStateFor(download);
    pausedDownloadStates.set(downloadId, pausedState);
    updateDownloadStatus(downloadId, { status: 'paused' });
    const paused = yield* backendAction(download, 'pause').pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          logger.sync.error(formatError(error));
          return false;
        })
      )
    );
    if (!paused) {
      pausedDownloadStates.delete(downloadId);
      updateDownloadStatus(downloadId, { status: 'downloading' });
      return false;
    }

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'info',
      message: `Paused download: ${download.name}`,
    });
    return true;
  });
}

export function resumeDownload(downloadId: string) {
  return Effect.suspend(() => {
    if (resumeInFlight.has(downloadId)) return Effect.succeed(false);
    resumeInFlight.add(downloadId);

    return Effect.gen(function* () {
      let pausedState = pausedDownloadStates.get(downloadId);
      const reconstructed = !pausedState;
      if (!pausedState) {
        const download = getDownloadItem(downloadId);
        if (!download) return false;
        pausedState = pausedStateFor(download);
        pausedDownloadStates.set(downloadId, pausedState);
      }

      const download = pausedState.downloadInfo;
      const redistributableInstall = get(redistributableInstalls)[downloadId];
      if (redistributableInstall && !redistributableInstall.isComplete) {
        updateDownloadStatus(downloadId, {
          status: 'installing-redistributables',
        });
        pausedDownloadStates.delete(downloadId);
        createNotification({
          id: Math.random().toString(36).substring(2, 9),
          type: 'info',
          message: `Resuming dependency installation: ${download.name}`,
        });
        yield* Effect.forkDaemon(
          startRedistributableInstallation(
            downloadId,
            redistributableInstall.appID
          )
        );
        return true;
      }

      updateDownloadStatus(downloadId, { status: 'downloading' });
      if (reconstructed) {
        const restarted = yield* restartDownload(
          pausedState,
          pausedDownloadStates
        );
        if (restarted) yield* enqueueRemainingPausedDownloads(downloadId);
        return restarted;
      }

      const resumed = yield* backendAction(download, 'resume').pipe(
        Effect.catchAll(() => Effect.succeed(false))
      );
      if (resumed) {
        pausedDownloadStates.delete(downloadId);
        deletePersistedDownload(downloadId);
        createNotification({
          id: Math.random().toString(36).substring(2, 9),
          type: 'info',
          message: `Resumed download: ${download.name}`,
        });
        return true;
      }

      const restarted = yield* restartDownload(
        pausedState,
        pausedDownloadStates
      );
      if (restarted) yield* enqueueRemainingPausedDownloads(downloadId);
      return restarted;
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          const message = formatError(error) || 'Failed to resume download';
          updateDownloadStatus(downloadId, { status: 'error', error: message });
          createNotification({
            id: Math.random().toString(36).substring(2, 9),
            type: 'error',
            message,
          });
          return false;
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          resumeInFlight.delete(downloadId);
        })
      )
    );
  });
}

export function cancelPausedDownload(downloadId: string) {
  return Effect.gen(function* () {
    const pausedState = pausedDownloadStates.get(downloadId);
    const item = pausedState?.downloadInfo ?? getDownloadItem(downloadId);
    pausedDownloadStates.delete(downloadId);
    runDetached(
      electronRpc.queue.cancel(downloadId),
      `Failed to cancel download ${downloadId}`
    );
    yield* deleteDownloadedItems(downloadId);
    deletePersistedDownload(downloadId);
    currentDownloads.update((downloads) =>
      downloads.filter((download) => download.id !== downloadId)
    );
    if (item) {
      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'info',
        message: `Cancelled download: ${item.name}`,
      });
    }
  });
}
