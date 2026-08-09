import type {
  LibraryInfo,
  SetupCommandData,
  SetupEventResponse,
} from '@ogi-sdk/connect';
import {
  AddonError,
  formatError,
  GameNotFound,
  UpdateError,
} from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { get } from 'svelte/store';
import { addonServer } from '@/frontend/lib/core/ipc';
import { getApp } from '@/frontend/lib/core/library';
import { updateDownloadStatus } from '@/frontend/lib/downloads/lifecycle';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import { saveFailedSetup } from '@/frontend/lib/recovery/failedSetups';
import { updatesManager } from '@/frontend/states.svelte';
import {
  createNotification,
  type DownloadStatusAndInfo,
  redistributableInstalls,
  setupLogs,
} from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

type SetupKind = 'game' | 'update';
type AdditionalSetupData = Record<string, unknown>;

type RedistributableProgressDetail = {
  appID: number;
  downloadId?: string;
  kind: 'item' | 'done';
  total: number;
  completedCount: number;
  failedCount: number;
  overallProgress: number;
  redistributableName?: string;
  redistributablePath?: string;
  index?: number;
  status?: 'installing' | 'completed' | 'failed';
  result?: 'success' | 'failed' | 'not-found';
  error?: string;
};

function dispatchSetupEvent(
  eventType: 'log' | 'progress',
  downloadID: string,
  data: unknown
): void {
  document.dispatchEvent(
    new CustomEvent(`setup:${eventType}`, {
      detail: {
        id: downloadID,
        [eventType === 'log' ? 'log' : 'progress']: data,
      },
    })
  );
}

function markSetupLogInactive(downloadId: string): void {
  setupLogs.update((logs) => {
    if (logs[downloadId]) logs[downloadId].isActive = false;
    return logs;
  });
}

export function createSetupPayload(
  downloadedItem: DownloadStatusAndInfo,
  path: string,
  forType: SetupKind,
  currentLibraryInfo: LibraryInfo | undefined,
  additionalData: AdditionalSetupData = {}
): SetupCommandData & { addonID: string } {
  return {
    addonID: downloadedItem.addonSource,
    path,
    type: downloadedItem.downloadType as 'direct' | 'torrent' | 'magnet',
    name: downloadedItem.name,
    usedRealDebrid: downloadedItem.usedDebridService !== undefined,
    clearOldFilesBeforeUpdate: downloadedItem.clearOldFilesBeforeUpdate,
    appID: downloadedItem.appID,
    storefront: downloadedItem.storefront,
    for: forType,
    ...(currentLibraryInfo ? { currentLibraryInfo } : {}),
    multiPartFiles:
      downloadedItem.downloadType === 'direct'
        ? structuredClone(downloadedItem.files ?? [])
        : [],
    manifest: structuredClone(downloadedItem.manifest ?? {}),
    ...additionalData,
  } as SetupCommandData & { addonID: string };
}

export function handleSetupError(
  error: unknown,
  downloadedItem: DownloadStatusAndInfo,
  forType: SetupKind = 'game',
  currentLibraryInfo?: LibraryInfo
): void {
  logger.sync.error('Error setting up app:', error);
  const errorMessage =
    formatError(error) || 'The addon crashed while setting up.';

  createNotification({
    id: Math.random().toString(36).substring(2, 9),
    type: 'error',
    message: errorMessage,
  });
  updateDownloadStatus(downloadedItem.id, {
    status: 'error',
    error: errorMessage,
  });
  markSetupLogInactive(downloadedItem.id);

  const baseData = {
    path: downloadedItem.downloadPath,
    type: downloadedItem.downloadType as 'direct' | 'torrent' | 'magnet',
    name: downloadedItem.name,
    usedRealDebrid: downloadedItem.usedDebridService !== undefined,
    clearOldFilesBeforeUpdate: downloadedItem.clearOldFilesBeforeUpdate,
    appID: downloadedItem.appID,
    storefront: downloadedItem.storefront,
    multiPartFiles:
      downloadedItem.downloadType === 'direct'
        ? downloadedItem.files
        : undefined,
    manifest: downloadedItem.manifest ?? {},
  };
  const setupData: SetupCommandData =
    forType === 'update' && currentLibraryInfo
      ? { ...baseData, for: 'update', currentLibraryInfo }
      : { ...baseData, for: 'game' };

  saveFailedSetup({
    downloadInfo: downloadedItem,
    setupData,
    error: errorMessage,
    should: 'call-addon',
  });
}

export function createSetupCallbacks(
  downloadedItem: DownloadStatusAndInfo,
  forType: SetupKind = 'game',
  currentLibraryInfo?: LibraryInfo
) {
  return {
    onLogs: (log: string[]) =>
      dispatchSetupEvent('log', downloadedItem.id, log),
    onProgress: (progress: unknown) =>
      dispatchSetupEvent('progress', downloadedItem.id, progress),
    onFailed: (error: unknown) =>
      handleSetupError(error, downloadedItem, forType, currentLibraryInfo),
  };
}

function runAddonSetup(
  setupPayload: SetupCommandData & { addonID: string },
  callbacks: ReturnType<typeof createSetupCallbacks>
) {
  const { addonID, ...setupArgs } = setupPayload;
  return Effect.tryPromise({
    try: () =>
      addonServer
        .addon(addonID, callbacks)
        .setup(setupArgs) as Promise<SetupEventResponse>,
    catch: (cause) =>
      new AddonError({
        message: formatError(cause),
        addonName: addonID,
      }),
  });
}

function applyRedistributableProgress(
  downloadId: string,
  progress: RedistributableProgressDetail
): void {
  redistributableInstalls.update((setups) => {
    const current = setups[downloadId];
    if (!current) return setups;

    const overallProgress = Number.isFinite(progress.overallProgress)
      ? Math.max(0, Math.min(100, progress.overallProgress))
      : current.overallProgress;
    const redistributables = [...current.redistributables];

    if (progress.kind === 'item') {
      let index = typeof progress.index === 'number' ? progress.index : -1;
      if (index < 0 || index >= redistributables.length) {
        index = redistributables.findIndex(
          (item) =>
            item.name === progress.redistributableName &&
            item.path === progress.redistributablePath
        );
      }
      if (index >= 0 && progress.status) {
        redistributables[index] = {
          ...redistributables[index],
          status: progress.status,
        };
      }
      return {
        ...setups,
        [downloadId]: {
          ...current,
          redistributables,
          overallProgress,
          isComplete: false,
        },
      };
    }

    return {
      ...setups,
      [downloadId]: {
        ...current,
        overallProgress: 100,
        isComplete: true,
        error:
          progress.result === 'success'
            ? undefined
            : (progress.error ?? 'Redistributable installation failed'),
      },
    };
  });
}

export function startRedistributableInstallation(
  downloadId: string,
  appID: number
) {
  return Effect.gen(function* () {
    const setup = get(redistributableInstalls)[downloadId];
    if (!setup) return;

    let sawBackendProgress = false;
    const onProgress = (event: Event): void => {
      const detail = (event as CustomEvent<RedistributableProgressDetail>)
        .detail;
      if (!detail || detail.appID !== appID) return;
      if (detail.downloadId && detail.downloadId !== downloadId) return;
      sawBackendProgress = true;
      applyRedistributableProgress(downloadId, detail);
    };

    document.addEventListener('app:redistributable-progress', onProgress);
    const result = yield* electronRpc.app
      .installRedistributables(appID, downloadId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new AddonError({
              message: `Redistributable installation failed: ${formatError(cause)}`,
            })
        ),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            logger.sync.error(
              '[setup] Redistributable installation error:',
              error
            );
            return 'failed' as const;
          })
        ),
        Effect.ensuring(
          Effect.sync(() =>
            document.removeEventListener(
              'app:redistributable-progress',
              onProgress
            )
          )
        )
      );

    if (!sawBackendProgress) {
      const status = result === 'success' ? 'completed' : 'failed';
      redistributableInstalls.update((setups) => {
        const current = setups[downloadId];
        if (!current) return setups;
        return {
          ...setups,
          [downloadId]: {
            ...current,
            redistributables: current.redistributables.map((item) => ({
              ...item,
              status,
            })),
            overallProgress: 100,
            isComplete: true,
            error:
              result === 'success'
                ? undefined
                : result === 'not-found'
                  ? 'Game not found while installing redistributables'
                  : 'Redistributable installation failed',
          },
        };
      });
    }

    if (result === 'success') {
      updateDownloadStatus(downloadId, { status: 'setup-complete' });
      redistributableInstalls.update((setups) => {
        const { [downloadId]: _, ...remaining } = setups;
        return remaining;
      });
      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'success',
        message: `Setup complete for ${setup.gameName}!`,
      });
      return;
    }

    updateDownloadStatus(downloadId, {
      status: 'error',
      error:
        result === 'not-found'
          ? 'redistributables-app-not-found'
          : 'setup-redistributables-failed',
    });
    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: `Redistributable install failed for ${setup.gameName}.`,
    });
  });
}

export function runSetupApp(
  downloadedItem: DownloadStatusAndInfo,
  outputDir: string,
  isTorrent: boolean,
  additionalData: AdditionalSetupData = {}
) {
  return Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: () =>
        createSetupPayload(
          downloadedItem,
          outputDir,
          'game',
          undefined,
          additionalData
        ),
      catch: (cause) =>
        new AddonError({
          message: `Failed to create setup payload: ${formatError(cause)}`,
          addonName: downloadedItem.addonSource,
        }),
    });
    const data = yield* runAddonSetup(
      payload,
      createSetupCallbacks(downloadedItem)
    );
    if (data.redistributables?.length) {
      updateDownloadStatus(downloadedItem.id, {
        status: 'redistr-downloading',
      });
    }
    markSetupLogInactive(downloadedItem.id);

    const result = yield* electronRpc.app
      .insertApp({
        ...data,
        capsuleImage: downloadedItem.capsuleImage,
        coverImage: downloadedItem.coverImage,
        name: downloadedItem.name,
        appID: downloadedItem.appID,
        storefront: downloadedItem.storefront,
        addonsource: downloadedItem.addonSource,
        redistributables: data.redistributables,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AddonError({
              message: `Failed to insert app: ${formatError(cause)}`,
              addonName: downloadedItem.addonSource,
            })
        ),
        Effect.tapError((error) =>
          Effect.sync(() => handleSetupError(error, downloadedItem, 'game'))
        )
      );

    if (
      result === 'setup-failed' ||
      result === 'setup-redistributables-failed'
    ) {
      updateDownloadStatus(downloadedItem.id, {
        status: 'error',
        error: result,
      });
      return yield* Effect.fail(new AddonError({ message: result }));
    }

    if (result === 'setup-prefix-required') {
      redistributableInstalls.update((setups) => ({
        ...setups,
        [downloadedItem.id]: {
          downloadId: downloadedItem.id,
          appID: downloadedItem.appID,
          gameName: downloadedItem.name,
          addonSource: downloadedItem.addonSource,
          redistributables: (data.redistributables ?? []).map((item) => ({
            ...item,
            status: 'pending',
          })),
          overallProgress: 0,
          isComplete: false,
        },
      }));
      updateDownloadStatus(downloadedItem.id, {
        status: 'installing-redistributables',
        downloadPath: downloadedItem.downloadPath,
      });
      yield* Effect.forkDaemon(
        startRedistributableInstallation(
          downloadedItem.id,
          downloadedItem.appID
        )
      );
      return data;
    }

    updateDownloadStatus(downloadedItem.id, {
      status: isTorrent ? 'seeding' : 'setup-complete',
      downloadPath: downloadedItem.downloadPath,
    });
    return data;
  }).pipe(
    Effect.tapError((error) => logger.error('Error setting up app:', error))
  );
}

export function runSetupAppUpdate(
  downloadedItem: DownloadStatusAndInfo,
  outputDir: string,
  isTorrent: boolean,
  additionalData: AdditionalSetupData = {},
  deferLibraryUpdate: boolean = false
) {
  const currentLibraryInfo = getApp(downloadedItem.appID);
  if (!currentLibraryInfo) {
    updateDownloadStatus(downloadedItem.id, {
      status: 'error',
      error: `App not found in library (appID: ${downloadedItem.appID})`,
    });
    return Effect.fail(new GameNotFound({ gameId: downloadedItem.appID }));
  }

  return Effect.gen(function* () {
    const data = yield* runAddonSetup(
      createSetupPayload(
        downloadedItem,
        outputDir,
        'update',
        currentLibraryInfo,
        additionalData
      ),
      createSetupCallbacks(downloadedItem, 'update', currentLibraryInfo)
    );
    markSetupLogInactive(downloadedItem.id);

    if (deferLibraryUpdate) return data;

    yield* finalizeSetupAppUpdate(downloadedItem, isTorrent, data);
    return data;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof GameNotFound || error instanceof UpdateError
        ? error
        : new UpdateError({ message: formatError(error), cause: error })
    )
  );
}

export function finalizeSetupAppUpdate(
  downloadedItem: DownloadStatusAndInfo,
  isTorrent: boolean,
  data: SetupEventResponse
) {
  return Effect.gen(function* () {
    const result = yield* electronRpc.app
      .updateAppVersion(
        downloadedItem.appID,
        data.version,
        data.cwd,
        data.launchExecutable,
        data.launchArguments,
        downloadedItem.addonSource,
        data.umu,
        data.launchEnv
      )
      .pipe(
        Effect.mapError(
          (cause) => new UpdateError({ message: formatError(cause), cause })
        )
      );
    if (result === 'app-not-found') {
      updateDownloadStatus(downloadedItem.id, {
        status: 'error',
        error: 'App not found in library',
      });
      return yield* Effect.fail(
        new GameNotFound({ gameId: downloadedItem.appID })
      );
    }

    if (data.version === downloadedItem.updateVersion) {
      updatesManager.removeAppUpdate(downloadedItem.appID);
      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'success',
        message: `Updated ${downloadedItem.name} to version ${data.version}`,
      });
    } else {
      const message = `Version mismatch: expected ${downloadedItem.updateVersion}, got ${data.version}`;
      updateDownloadStatus(downloadedItem.id, {
        status: 'error',
        error: message,
      });
      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'error',
        message: `Failed to update ${downloadedItem.name} to target version`,
      });
      return yield* Effect.fail(new UpdateError({ message }));
    }

    updateDownloadStatus(downloadedItem.id, {
      status: isTorrent ? 'seeding' : 'setup-complete',
      downloadPath: downloadedItem.downloadPath,
    });
  });
}
