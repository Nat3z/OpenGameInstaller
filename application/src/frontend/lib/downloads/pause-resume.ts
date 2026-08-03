import { DownloadError, formatError } from '@ogi/errors';
import { Effect } from 'effect';
import { get } from 'svelte/store';
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
import { startRedistributableInstallation } from '@/frontend/lib/setup/setup';
import {
  createNotification,
  currentDownloads,
  type DownloadStatusAndInfo,
  redistributableInstalls,
} from '@/frontend/store.svelte';

const pausedDownloadStates = new Map<string, PausedDownloadState>();
let hasBulkQueuedRestoredDownloads = false;
let bulkQueueRunning = false;
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
      ? () =>
          action === 'pause'
            ? window.electronAPI.ddl.pauseDownload(download.id)
            : window.electronAPI.ddl.resumeDownload(download.id)
      : download.downloadType === 'torrent' ||
          download.downloadType === 'magnet'
        ? () =>
            action === 'pause'
              ? window.electronAPI.torrent.pauseDownload(download.id)
              : window.electronAPI.torrent.resumeDownload(download.id)
        : undefined;

  return operation
    ? Effect.tryPromise({
        try: () => operation().then(() => undefined),
        catch: (cause) =>
          new DownloadError({
            message: `Failed to ${action} download: ${formatError(cause)}`,
            downloadId: download.id,
            cause,
          }),
      }).pipe(Effect.as(true))
    : Effect.succeed(false);
}

function enqueueRemainingPausedDownloads(resumedId: string) {
  return Effect.gen(function* () {
    if (hasBulkQueuedRestoredDownloads) return;
    while (bulkQueueRunning) yield* Effect.sleep(25);
    if (hasBulkQueuedRestoredDownloads) return;

    bulkQueueRunning = true;
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
      Effect.sync(() => {
        bulkQueueRunning = false;
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
          console.error(formatError(error));
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

    const restarted = yield* restartDownload(pausedState, pausedDownloadStates);
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
}

export function cancelPausedDownload(downloadId: string) {
  return Effect.gen(function* () {
    const pausedState = pausedDownloadStates.get(downloadId);
    const item = pausedState?.downloadInfo ?? getDownloadItem(downloadId);
    pausedDownloadStates.delete(downloadId);
    window.electronAPI.queue.cancel(downloadId);
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
