import { FileSystemError, formatError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { Effect } from 'effect';
import { get } from 'svelte/store';
import { getPersistedFilePaths } from '@/frontend/lib/downloads/paths';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import {
  currentDownloads,
  type DownloadStatusAndInfo,
  type RedistributableInstall,
  redistributableInstalls,
} from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

type PersistableStatus =
  | 'downloading'
  | 'paused'
  | 'installing-redistributables';

const PERSIST_DIR = './in-progress-downloads';

interface PersistedRecord {
  id: string;
  updatedAt: number;
  downloadInfo: DownloadStatusAndInfo;
  redistributableInstall?: RedistributableInstall;
}

const lastSavedAtById: Map<string, number> = new Map();
let unsubscribeDownloads: (() => void) | undefined;
let unsubscribeRedistributables: (() => void) | undefined;

function ensureDir(): Effect.Effect<void, FileSystemError> {
  return Effect.try({
    try: () => {
      if (!window.electronAPI.fs.exists(PERSIST_DIR)) {
        window.electronAPI.fs.mkdir(PERSIST_DIR);
      }
    },
    catch: (cause) =>
      new FileSystemError({
        message: `Failed to ensure persistence directory: ${formatError(cause)}`,
        path: PERSIST_DIR,
        cause,
      }),
  });
}

function isPersistableStatus(
  status: string | undefined
): status is PersistableStatus {
  return (
    status === 'downloading' ||
    status === 'paused' ||
    status === 'installing-redistributables'
  );
}

function recordPath(id: string) {
  return `${PERSIST_DIR}/${id}.json`;
}

function saveRecord(download: DownloadStatusAndInfo, force = false) {
  try {
    const now = Date.now();
    const last = lastSavedAtById.get(download.id) || 0;
    if (!force && now - last < 1000) return; // throttle per ID (1s)
    lastSavedAtById.set(download.id, now);

    const maybeRedistributableInstall =
      download.status === 'installing-redistributables'
        ? get(redistributableInstalls)[download.id]
        : undefined;

    const record: PersistedRecord = {
      id: download.id,
      updatedAt: now,
      downloadInfo: download,
      ...(maybeRedistributableInstall
        ? { redistributableInstall: maybeRedistributableInstall }
        : {}),
    };
    window.electronAPI.fs.write(
      recordPath(download.id),
      JSON.stringify(record, null, 2)
    );
  } catch (e) {
    logger.sync.error(
      'Failed to persist in-progress download:',
      download.id,
      e
    );
  }
}

function removeRecord(id: string) {
  try {
    const path = recordPath(id);
    window.electronAPI.fs.delete(path);
  } catch (e) {
    logger.sync.error('Failed to remove persisted download:', id, e);
  }
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
  return ensureDir().pipe(
    Effect.zipRight(
      electronRpc.fs.getFilesInDir(PERSIST_DIR).pipe(
        Effect.mapError(
          (cause) =>
            new FileSystemError({
              message: `Failed to load persisted downloads: ${formatError(cause)}`,
              path: PERSIST_DIR,
              cause,
            })
        )
      )
    ),
    Effect.map((files) => {
      const restored: DownloadStatusAndInfo[] = [];
      const redistributableInstallByDownloadId: Record<
        string,
        RedistributableInstall
      > = {};

      for (const file of files ?? []) {
        if (!file.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(
            window.electronAPI.fs.read(`${PERSIST_DIR}/${file}`)
          ) as PersistedRecord;
          if (!parsed?.downloadInfo) continue;
          const info = parsed.downloadInfo;
          if (!isPersistableStatus(info.status)) continue;

          if (info.status === 'installing-redistributables') {
            if (isRedistributableInstall(parsed.redistributableInstall)) {
              redistributableInstallByDownloadId[info.id] =
                parsed.redistributableInstall;
            }
            info.status = 'paused';
            restored.push(info);
            continue;
          }
          if (
            info.usedDebridService &&
            (info.downloadType === 'torrent' ||
              info.downloadType === 'magnet') &&
            (!info.downloadURL || info.downloadURL === info.originalDownloadURL)
          ) {
            continue;
          }
          info.status = 'paused';
          info.queuePosition = undefined;
          restored.push(info);
        } catch (error) {
          logger.sync.error('Failed to parse persisted download:', file, error);
        }
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
          logger.sync.error('Failed to hydrate persisted downloads:', error);
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
        if (!isPersistableStatus(download.status)) continue;
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

export function deleteDownloadedItems(id: string) {
  const record = recordPath(id);
  return Effect.try({
    try: () => {
      if (!window.electronAPI.fs.exists(record)) return undefined;
      return JSON.parse(window.electronAPI.fs.read(record)) as PersistedRecord;
    },
    catch: (cause) =>
      new FileSystemError({
        message: `Failed to read persisted download: ${formatError(cause)}`,
        path: record,
        cause,
      }),
  }).pipe(
    Effect.flatMap((parsed) =>
      parsed
        ? Effect.forEach(
            getPersistedFilePaths(parsed.downloadInfo),
            (filePath) =>
              electronRpc.fs.deleteAsync(filePath).pipe(
                Effect.mapError(
                  (cause) =>
                    new FileSystemError({
                      message: `Failed to delete downloaded file: ${formatError(cause)}`,
                      path: filePath,
                      cause,
                    })
                ),
                Effect.tapError((error) =>
                  logger.error(error.message, error.path, error.cause)
                ),
                Effect.ignore
              ),
            { discard: true }
          )
        : Effect.void
    )
  );
}

export function deletePersistedDownload(id: string) {
  removeRecord(id);
}
