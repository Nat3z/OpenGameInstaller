import { FileSystemError, formatError } from '@ogi/errors';
import type { SetupCommandData } from '@ogi-sdk/connect';
import { Effect, Schedule } from 'effect';
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

const FAILED_SETUPS_DIR = './failed-setups';

function failedSetupPath(id: string): string {
  return `${FAILED_SETUPS_DIR}/${id}.json`;
}

function ensureFailedSetupsDir(): void {
  if (!window.electronAPI.fs.exists(FAILED_SETUPS_DIR)) {
    window.electronAPI.fs.mkdir(FAILED_SETUPS_DIR);
  }
}

export function loadFailedSetups() {
  return Effect.tryPromise({
    try: () => window.electronAPI.fs.getFilesInDir(FAILED_SETUPS_DIR),
    catch: (cause) =>
      new FileSystemError({
        message: 'Failed to list saved setup recoveries.',
        path: FAILED_SETUPS_DIR,
        cause,
      }),
  }).pipe(
    Effect.tap(() => Effect.sync(ensureFailedSetupsDir)),
    Effect.map((files) => {
      const byDownloadId = new Map<string, FailedSetup>();
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const setup = JSON.parse(
            window.electronAPI.fs.read(`${FAILED_SETUPS_DIR}/${file}`)
          ) as FailedSetup;
          const key = setup.downloadInfo?.id ?? setup.id;
          if (!key) continue;
          const existing = byDownloadId.get(key);
          if (!existing || (setup.timestamp ?? 0) > (existing.timestamp ?? 0)) {
            byDownloadId.set(key, setup);
          }
        } catch (error) {
          console.error('Error loading failed setup file:', file, error);
        }
      }
      failedSetups.set(Array.from(byDownloadId.values()));
    }),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        if (!window.electronAPI.fs.exists(FAILED_SETUPS_DIR)) {
          ensureFailedSetupsDir();
          return;
        }
        console.error('Error loading failed setups:', error);
      })
    )
  );
}

export function removeFailedSetup(setupId: string): void {
  try {
    const path = failedSetupPath(setupId);
    if (window.electronAPI.fs.exists(path)) window.electronAPI.fs.delete(path);
    failedSetups.update((setups) =>
      setups.filter((setup) => setup.id !== setupId)
    );
  } catch (error) {
    console.error('Error removing failed setup:', error);
  }
}

export function saveFailedSetup(setupInfo: {
  downloadInfo: DownloadStatusAndInfo;
  setupData: SetupCommandData;
  error: string;
  should: 'call-addon' | 'call-unrar' | 'call-unzip';
}): void {
  try {
    ensureFailedSetupsDir();
    const id = setupInfo.downloadInfo.id;
    const saved: FailedSetup = {
      id,
      timestamp: Date.now(),
      ...setupInfo,
      retryCount: 0,
    };
    window.electronAPI.fs.write(
      failedSetupPath(id),
      JSON.stringify(saved, null, 2)
    );
    failedSetups.update((setups) => {
      const index = setups.findIndex((setup) => setup.downloadInfo?.id === id);
      if (index < 0) return [...setups, saved];
      const updated = [...setups];
      updated[index] = saved;
      return updated;
    });
  } catch (error) {
    console.error('Failed to save setup info:', error);
  }
}

function updateRetry(failedSetup: FailedSetup, error: unknown): void {
  const updated = {
    ...failedSetup,
    retryCount: failedSetup.retryCount + 1,
    error: formatError(error),
  };
  window.electronAPI.fs.write(
    failedSetupPath(failedSetup.id),
    JSON.stringify(updated, null, 2)
  );
  failedSetups.update((setups) =>
    setups.map((setup) => (setup.id === failedSetup.id ? updated : setup))
  );
}

function requiredArchiveFilename(
  failedSetup: FailedSetup,
  kind: 'RAR' | 'ZIP'
) {
  const download = failedSetup.downloadInfo;
  if (
    (download.downloadType === 'torrent' ||
      download.downloadType === 'magnet') &&
    download.filename
  ) {
    return Effect.succeed(download.filename);
  }
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
    failedSetups.update((setups) =>
      setups.filter((setup) => setup.id !== failedSetup.id)
    );
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
        console.error('Error retrying setup:', error);
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
