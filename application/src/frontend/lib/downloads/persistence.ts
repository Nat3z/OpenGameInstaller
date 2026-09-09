import { formatError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { get } from 'svelte/store';
import { runDetached } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import {
  currentDownloads,
  type DownloadStatusAndInfo,
  type RedistributableInstall,
  redistributableInstalls,
} from '@/frontend/store.svelte';
import type { PersistedDownload } from '@/lib/download-state';

const logger = createLogger(LOGGER_PREFIXES.frontend);

type PersistableStatus =
  | 'downloading'
  | 'merging'
  | 'paused'
  | 'installing-redistributables';

const lastSavedAtById: Map<string, number> = new Map();
let unsubscribeDownloads: (() => void) | undefined;
let unsubscribeRedistributables: (() => void) | undefined;

function isPersistableStatus(
  status: string | undefined
): status is PersistableStatus {
  return (
    status === 'downloading' ||
    status === 'merging' ||
    status === 'paused' ||
    status === 'installing-redistributables'
  );
}

// 'merging' is only persistable while the backend merges chunk files: the
// chunk files on disk let a restart resume without re-downloading. Post-
// download processing (moving/extracting) is covered by the failed-setups
// recovery record instead.
function isPersistableDownload(download: DownloadStatusAndInfo): boolean {
  return (
    isPersistableStatus(download.status) &&
    (download.status !== 'merging' ||
      download.processingPhase === 'Merging chunks')
  );
}

function saveRecord(download: DownloadStatusAndInfo, force = false) {
  const now = Date.now();
  const last = lastSavedAtById.get(download.id) || 0;
  if (!force && now - last < 1000) return; // throttle per ID (1s)
  lastSavedAtById.set(download.id, now);

  const maybeRedistributableInstall =
    download.status === 'installing-redistributables'
      ? get(redistributableInstalls)[download.id]
      : undefined;

  const record: PersistedDownload = {
    id: download.id,
    updatedAt: now,
    downloadInfo: download,
    ...(maybeRedistributableInstall
      ? { redistributableInstall: maybeRedistributableInstall }
      : {}),
  };
  runDetached(
    electronRpc.state.saveDownload(record),
    `Failed to persist in-progress download ${download.id}`
  );
}

function removeRecord(id: string) {
  runDetached(
    electronRpc.state.deleteDownload(id),
    `Failed to remove persisted download ${id}`
  );
}

function isRedistributableInstall(
  value: unknown
): value is RedistributableInstall {
  if (typeof value !== 'object' || value === null) return false;
  const setup = value as RedistributableInstall;
  return (
    typeof setup.downloadId === 'string' &&
    typeof setup.appID === 'number' &&
    typeof setup.gameName === 'string' &&
    typeof setup.addonSource === 'string' &&
    Array.isArray(setup.redistributables) &&
    setup.redistributables.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.name === 'string' &&
        typeof item.path === 'string' &&
        ['pending', 'installing', 'completed', 'failed'].includes(item.status)
    ) &&
    typeof setup.overallProgress === 'number' &&
    typeof setup.isComplete === 'boolean'
  );
}

export function loadPersistedDownloads() {
  return electronRpc.state.listDownloads().pipe(
    Effect.map((records) => {
      const restored: DownloadStatusAndInfo[] = [];
      const redistributableInstallByDownloadId: Record<
        string,
        RedistributableInstall
      > = {};

      for (const record of records) {
        const info = record.downloadInfo;
        if (!info || !isPersistableStatus(info.status)) continue;

        if (info.status === 'installing-redistributables') {
          if (isRedistributableInstall(record.redistributableInstall)) {
            redistributableInstallByDownloadId[info.id] =
              record.redistributableInstall;
          }
          info.status = 'paused';
          restored.push(info);
          continue;
        }
        if (
          info.usedDebridService &&
          (info.downloadType === 'torrent' || info.downloadType === 'magnet') &&
          (!info.downloadURL || info.downloadURL === info.originalDownloadURL)
        ) {
          continue;
        }
        info.status = 'paused';
        info.queuePosition = undefined;
        restored.push(info);
      }
      return { downloads: restored, redistributableInstallByDownloadId };
    })
  );
}

export function initDownloadPersistence() {
  return Effect.gen(function* () {
    const restoredState = yield* loadPersistedDownloads().pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          logger.sync.error(
            'Failed to hydrate persisted downloads:',
            formatError(error)
          );
          return {
            downloads: [],
            redistributableInstallByDownloadId: {},
          };
        })
      )
    );

    currentDownloads.update((downloads) => {
      const byId = new Map(
        downloads.map((download) => [download.id, download])
      );
      for (const restored of restoredState.downloads) {
        byId.set(restored.id, { ...byId.get(restored.id), ...restored });
      }
      return Array.from(byId.values());
    });
    redistributableInstalls.update((setups) => ({
      ...setups,
      ...restoredState.redistributableInstallByDownloadId,
    }));
    for (const [downloadId, install] of Object.entries(
      restoredState.redistributableInstallByDownloadId
    )) {
      if (!install.isComplete) continue;
      currentDownloads.update((downloads) =>
        downloads.map((download) =>
          download.id === downloadId && download.status === 'paused'
            ? { ...download, status: 'setup-complete' }
            : download
        )
      );
    }

    unsubscribeDownloads?.();
    unsubscribeRedistributables?.();

    let lastSnapshot: Record<string, string> = {};
    let lastRedistributableSnapshotById: Record<string, string> = {};
    let latestDownloads: DownloadStatusAndInfo[] = [];
    unsubscribeDownloads = currentDownloads.subscribe((downloads) => {
      latestDownloads = downloads;
      const nextSnapshot: Record<string, string> = {};
      for (const download of downloads) {
        if (!isPersistableDownload(download)) continue;
        // Addon-enqueued downloads can't be restored (owning addon session is gone).
        if (download.isAddonDownload) continue;
        const serialized = JSON.stringify(download);
        nextSnapshot[download.id] = serialized;
        if (lastSnapshot[download.id] !== serialized) saveRecord(download);
      }
      for (const previousId of Object.keys(lastSnapshot)) {
        if (previousId in nextSnapshot) continue;
        removeRecord(previousId);
        delete lastRedistributableSnapshotById[previousId];
      }
      lastSnapshot = nextSnapshot;
    });
    unsubscribeRedistributables = redistributableInstalls.subscribe(
      (setups) => {
        const downloadsById = new Map(
          latestDownloads.map((download) => [download.id, download])
        );
        for (const [downloadId, setup] of Object.entries(setups)) {
          const download = downloadsById.get(downloadId);
          if (!download || download.status !== 'installing-redistributables')
            continue;
          const serialized = JSON.stringify(setup);
          if (lastRedistributableSnapshotById[downloadId] !== serialized) {
            saveRecord(download, true);
            lastRedistributableSnapshotById[downloadId] = serialized;
          }
        }
      }
    );
  });
}

/** Removes the files a persisted download wrote to disk. */
export function deleteDownloadedItems(id: string) {
  return electronRpc.setup.deleteDownloadFiles(id).pipe(
    Effect.tapError((error) =>
      logger.error('Failed to delete downloaded files:', id, error)
    ),
    Effect.ignore
  );
}

export function deletePersistedDownload(id: string) {
  removeRecord(id);
}
