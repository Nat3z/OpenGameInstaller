import type { SetupCommandData } from '@ogi-sdk/connect';
import { FileSystemError, formatError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Schedule } from 'effect';
import { get } from 'svelte/store';
import { runDetached } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import {
  unrarAndReturnOutputDir,
  unzipAndReturnOutputDir,
} from '@/frontend/lib/setup/extraction';
import { runSetupApp, runSetupAppUpdate } from '@/frontend/lib/setup/setup';
import {
  createNotification,
  currentDownloads,
  type DownloadStatusAndInfo,
  type FailedSetup,
  failedSetups,
  setupLogs,
} from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

export function loadFailedSetups() {
  return electronRpc.state.listFailedSetups().pipe(
    Effect.map((setups) => {
      // Pending recoveries share this table; hide entries whose download is
      // still live in this session so they only surface after a crash.
      const activeDownloadIds = new Set(
        get(currentDownloads)
          .filter((download) => download.status !== 'error')
          .map((download) => download.id)
      );
      const byDownloadId = new Map<string, FailedSetup>();
      for (const setup of setups) {
        const key = setup.downloadInfo?.id ?? setup.id;
        if (!key || activeDownloadIds.has(key)) continue;
        const existing = byDownloadId.get(key);
        if (!existing || (setup.timestamp ?? 0) > (existing.timestamp ?? 0)) {
          byDownloadId.set(key, setup);
        }
      }
      failedSetups.set(Array.from(byDownloadId.values()));
    }),
    Effect.catchAll((error) =>
      logger.error('Error loading failed setups:', error)
    )
  );
}

function persist(setup: FailedSetup, label: string): void {
  runDetached(electronRpc.state.saveFailedSetup(setup), label);
}

export function removeFailedSetup(setupId: string): void {
  runDetached(
    electronRpc.state.deleteFailedSetup(setupId),
    'Error removing failed setup'
  );
  failedSetups.update((setups) =>
    setups.filter((setup) => setup.id !== setupId)
  );
}

export function saveFailedSetup(setupInfo: {
  downloadInfo: DownloadStatusAndInfo;
  setupData: SetupCommandData;
  error: string;
  should: 'call-addon' | 'call-unrar' | 'call-unzip';
}): void {
  const id = setupInfo.downloadInfo.id;
  const saved: FailedSetup = {
    id,
    timestamp: Date.now(),
    ...setupInfo,
    retryCount: 0,
  };
  persist(saved, 'Failed to save setup info');
  failedSetups.update((setups) => {
    const index = setups.findIndex((setup) => setup.downloadInfo?.id === id);
    if (index < 0) return [...setups, saved];
    const updated = [...setups];
    updated[index] = saved;
    return updated;
  });
}

/**
 * Saves a recovery record without surfacing it in the failed-setups store.
 * Saved once old_files staging is done and again after extraction, so closing
 * the app mid-processing leaves a recoverable entry on next launch instead of
 * forcing a re-download. Deleted once setup completes.
 */
export function savePendingRecovery(setupInfo: {
  downloadInfo: DownloadStatusAndInfo;
  setupData: SetupCommandData;
  should: 'call-addon' | 'call-unrar' | 'call-unzip';
}): void {
  const id = setupInfo.downloadInfo.id;
  persist(
    {
      id,
      timestamp: Date.now(),
      ...setupInfo,
      error: 'The app was closed before setup could finish.',
      retryCount: 0,
    },
    'Failed to save pending recovery'
  );
}

function updateRetry(failedSetup: FailedSetup, error: unknown): void {
  const updated = {
    ...failedSetup,
    retryCount: failedSetup.retryCount + 1,
    error: formatError(error),
  };
  persist(updated, 'Failed to persist setup retry');
  failedSetups.update((setups) =>
    setups.map((setup) => (setup.id === failedSetup.id ? updated : setup))
  );
}

function requiredArchiveFilename(
  failedSetup: FailedSetup,
  kind: 'RAR' | 'ZIP'
) {
  const download = failedSetup.downloadInfo;
  const persistedPath = download.files?.[0]?.path;
  const filename =
    ('filename' in download ? download.filename : undefined) ??
    download.files?.[0]?.name ??
    persistedPath?.split(/[/\\]/).pop() ??
    download.downloadPath?.split(/[/\\]/).pop();
  if (filename) return Effect.succeed(filename);
  return Effect.fail(
    new FileSystemError({
      message: `Cannot extract ${kind}: filename not available for this download type`,
      path: download.downloadPath,
    })
  );
}

export function retryFailedSetup(failedSetup: FailedSetup) {
  const tempId = Math.random().toString(36).substring(7);

  return Effect.gen(function* () {
    currentDownloads.update((downloads) => [
      ...downloads,
      { ...failedSetup.downloadInfo, id: tempId, status: 'completed' },
    ]);

    const setupData = failedSetup.setupData;
    if (failedSetup.should === 'call-unrar') {
      const filename = yield* requiredArchiveFilename(failedSetup, 'RAR');
      const base = failedSetup.downloadInfo.downloadPath.replace(
        /(\/|\\)$/g,
        ''
      );
      const extractedDir = yield* unrarAndReturnOutputDir({
        rarFilePath: `${base}/${filename}`,
        outputBaseDir: `${base}/${failedSetup.downloadInfo.name}`,
        downloadId: tempId,
      });
      if (extractedDir === null) {
        return yield* Effect.fail(
          new FileSystemError({
            message: 'RAR extraction did not return an output directory.',
            path: `${base}/${filename}`,
          })
        );
      }
      setupData.path = extractedDir;
      failedSetup.downloadInfo.downloadPath = extractedDir;
      failedSetup.should = 'call-addon';
    }

    if (failedSetup.should === 'call-unzip') {
      const filename = yield* requiredArchiveFilename(failedSetup, 'ZIP');
      const zipPath = `${failedSetup.downloadInfo.downloadPath.replace(/(\/|\\)$/g, '')}/${filename}`;
      const outputDir = yield* unzipAndReturnOutputDir({
        zipFilePath: zipPath,
        outputDirBase: zipPath.replace(/\.zip$/g, ''),
        downloadId: tempId,
      }).pipe(
        Effect.flatMap((output) =>
          output
            ? Effect.succeed(output)
            : Effect.fail(
                new FileSystemError({
                  message: 'ZIP extraction returned no output directory.',
                  path: zipPath,
                })
              )
        ),
        Effect.retry(
          Schedule.intersect(Schedule.recurs(2), Schedule.spaced(1000))
        )
      );
      failedSetup.downloadInfo.downloadPath = outputDir;
      setupData.path = outputDir;
      failedSetup.should = 'call-addon';
    }

    setupLogs.update((logs) => ({
      ...logs,
      [tempId]: {
        downloadId: tempId,
        logs: [],
        progress: 0,
        isActive: true,
      },
    }));

    const downloadItem: DownloadStatusAndInfo = {
      ...failedSetup.downloadInfo,
      id: tempId,
    };
    const isTorrent =
      downloadItem.downloadType === 'torrent' ||
      downloadItem.downloadType === 'magnet';
    const additionalData: Record<string, unknown> = {};
    if (!isTorrent && downloadItem.files?.length) {
      additionalData.multiPartFiles = structuredClone(downloadItem.files);
    }

    const isUpdate =
      downloadItem.isUpdate === true || failedSetup.setupData.for === 'update';
    yield* isUpdate
      ? runSetupAppUpdate(
          downloadItem,
          setupData.path,
          isTorrent,
          additionalData
        )
      : runSetupApp(downloadItem, setupData.path, isTorrent, additionalData);

    removeFailedSetup(failedSetup.id);
    createNotification({
      id: Math.random().toString(36).substring(7),
      type: 'success',
      message: `Successfully set up ${failedSetup.downloadInfo.name}`,
    });
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        logger.sync.error('Error retrying setup:', error);
        currentDownloads.update((downloads) =>
          downloads.filter((download) => download.id !== tempId)
        );
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: `Failed to retry setup for ${failedSetup.downloadInfo.name}`,
        });
        updateRetry(failedSetup, error);
      })
    )
  );
}
