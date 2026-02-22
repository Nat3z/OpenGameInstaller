import {
  createNotification,
  setupLogs,
  redistributableInstalls,
  type DownloadStatusAndInfo,
} from '../../store';
import { get } from 'svelte/store';
import { updateDownloadStatus } from '../downloads/lifecycle';
import { saveFailedSetup } from '../recovery/failedSetups';
import type {
  EventListenerTypes,
  LibraryInfo,
  SetupEventResponse,
} from 'ogi-addon';
import { safeFetch } from '../core/ipc';
import { updatesManager } from '../../states.svelte';
import { getApp } from '../core/library';

function dispatchSetupEvent(
  eventType: 'log' | 'progress',
  downloadID: string,
  data: any
) {
  document.dispatchEvent(
    new CustomEvent(`setup:${eventType}`, {
      detail: {
        id: downloadID,
        [eventType === 'log' ? 'log' : 'progress']: data,
      },
    })
  );
}

export function createSetupPayload(
  downloadedItem: DownloadStatusAndInfo,
  path: string,
  forType: 'game' | 'update',
  currentLibraryInfo: LibraryInfo | undefined,
  additionalData: any = {}
) {
  return {
    addonID: downloadedItem.addonSource,
    path,
    type: downloadedItem.downloadType,
    name: downloadedItem.name,
    usedRealDebrid: downloadedItem.usedDebridService !== undefined,
    clearOldFilesBeforeUpdate: downloadedItem.clearOldFilesBeforeUpdate,
    appID: downloadedItem.appID,
    storefront: downloadedItem.storefront,
    for: forType,
    ...(currentLibraryInfo ? { currentLibraryInfo } : {}),
    multiPartFiles: JSON.parse(
      JSON.stringify(
        downloadedItem.downloadType === 'direct'
          ? downloadedItem.files || []
          : []
      )
    ),
    manifest: JSON.parse(JSON.stringify(downloadedItem.manifest || {})),
    ...additionalData,
  };
}

export function handleSetupError(
  error: any,
  downloadedItem: DownloadStatusAndInfo,
  forType: 'game' | 'update' = 'game',
  currentLibraryInfo?: LibraryInfo
) {
  console.error('Error setting up app: ', error);

  // Normalize error to a safe string
  let errorMessage: string;
  if (error?.message) {
    errorMessage = String(error.message);
  } else if (error !== null && error !== undefined) {
    const stringified = String(error);
    if (stringified === '[object Object]') {
      try {
        errorMessage = JSON.stringify(error);
      } catch {
        errorMessage = 'The addon had crashed while setting up.';
      }
    } else {
      errorMessage = stringified;
    }
  } else {
    errorMessage = 'The addon had crashed while setting up.';
  }

  createNotification({
    id: Math.random().toString(36).substring(2, 9),
    type: 'error',
    message: errorMessage,
  });

  updateDownloadStatus(downloadedItem.id, {
    status: 'error',
    error: error?.message || error,
  });

  // Mark setup log as inactive
  setupLogs.update((logs) => {
    if (logs[downloadedItem.id]) {
      logs[downloadedItem.id].isActive = false;
    }
    return logs;
  });

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
    manifest: downloadedItem.manifest || {},
  };

  const setupData: Parameters<EventListenerTypes['setup']>[0] =
    forType === 'update' && currentLibraryInfo
      ? {
          ...baseData,
          for: 'update',
          currentLibraryInfo,
        }
      : {
          ...baseData,
          for: 'game',
        };

  saveFailedSetup({
    downloadInfo: downloadedItem,
    setupData,
    error: error?.message || error,
    should: 'call-addon',
  });
}

export function createSetupCallbacks(
  downloadedItem: DownloadStatusAndInfo,
  forType: 'game' | 'update' = 'game',
  currentLibraryInfo?: LibraryInfo
) {
  return {
    onLogs: (log: string[]) =>
      dispatchSetupEvent('log', downloadedItem.id, log),
    onProgress: (progress: any) =>
      dispatchSetupEvent('progress', downloadedItem.id, progress),
    onFailed: (error: any) =>
      handleSetupError(error, downloadedItem, forType, currentLibraryInfo),
    consume: 'json' as const,
  };
}

export async function runSetupApp(
  downloadedItem: DownloadStatusAndInfo,
  outputDir: string,
  isTorrent: boolean,
  additionalData: any = {}
): Promise<SetupEventResponse> {
  const setupPayload = createSetupPayload(
    downloadedItem,
    outputDir,
    'game',
    undefined,
    additionalData
  );
  const callbacks = createSetupCallbacks(downloadedItem, 'game');

  try {
    const data: SetupEventResponse = await safeFetch(
      'setupApp',
      setupPayload,
      callbacks
    );

    if (data.redistributables && data.redistributables.length > 0) {
      updateDownloadStatus(downloadedItem.id, {
        status: 'redistr-downloading',
      });
    }

    // Mark setup log as inactive
    setupLogs.update((logs) => {
      if (logs[downloadedItem.id]) {
        logs[downloadedItem.id].isActive = false;
      }
      return logs;
    });

    const result = await window.electronAPI.app.insertApp({
      ...data,
      capsuleImage: downloadedItem.capsuleImage,
      coverImage: downloadedItem.coverImage,
      name: downloadedItem.name,
      appID: downloadedItem.appID,
      storefront: downloadedItem.storefront,
      addonsource: downloadedItem.addonSource,
      redistributables: data.redistributables,
    });

    if (
      result === 'setup-failed' ||
      result === 'setup-redistributables-failed'
    ) {
      updateDownloadStatus(downloadedItem.id, {
        status: 'error',
        error: result,
      });
      throw new Error(result);
    }

    // Handle redistributable installation for Linux
    if (result === 'setup-prefix-required') {
      console.log(
        '[setup] Installing redistributables for:',
        downloadedItem.name
      );

      // Initialize redistributable installation progress
      redistributableInstalls.update((setups) => ({
        ...setups,
        [downloadedItem.id]: {
          downloadId: downloadedItem.id,
          appID: downloadedItem.appID,
          gameName: downloadedItem.name,
          addonSource: downloadedItem.addonSource,
          redistributables: (data.redistributables || []).map((r) => ({
            ...r,
            status: 'pending',
          })),
          overallProgress: 0,
          isComplete: false,
        },
      }));

      // Update download status to show progress UI
      updateDownloadStatus(downloadedItem.id, {
        status: 'installing-redistributables',
        downloadPath: downloadedItem.downloadPath,
      });

      // Start auto-installation in background (guard against unhandled rejections)
      startRedistributableInstallation(downloadedItem.id, downloadedItem.appID).catch(
        (err) => console.error('[setup] startRedistributableInstallation failed:', err)
      );

      return data;
    }

    const finalStatus = isTorrent ? 'seeding' : 'setup-complete';
    updateDownloadStatus(downloadedItem.id, {
      status: finalStatus,
      downloadPath: downloadedItem.downloadPath,
    });

    return data;
  } catch (error) {
    // Error flows already handled in callbacks; rethrow for callers to react if needed
    console.error('Error setting up app: ', error);
    throw error;
  }
}

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

function applyRedistributableProgress(
  downloadId: string,
  progress: RedistributableProgressDetail
) {
  redistributableInstalls.update((setups) => {
    const current = setups[downloadId];
    if (!current) return setups;

    const overallProgress = Number.isFinite(progress.overallProgress)
      ? Math.max(0, Math.min(100, progress.overallProgress))
      : current.overallProgress;
    const updatedRedistributables = [...current.redistributables];

    if (progress.kind === 'item') {
      let targetIndex =
        typeof progress.index === 'number' ? progress.index : -1;
      if (targetIndex < 0 || targetIndex >= updatedRedistributables.length) {
        targetIndex = updatedRedistributables.findIndex(
          (redist) =>
            redist.name === progress.redistributableName &&
            redist.path === progress.redistributablePath
        );
      }

      if (targetIndex >= 0 && progress.status) {
        updatedRedistributables[targetIndex] = {
          ...updatedRedistributables[targetIndex],
          status: progress.status,
        };
      }

      return {
        ...setups,
        [downloadId]: {
          ...current,
          redistributables: updatedRedistributables,
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
            : progress.error || 'Redistributable installation failed',
      },
    };
  });
}

/**
 * Start redistributable installation in background
 * Progress is driven by backend UMU events.
 */
export async function startRedistributableInstallation(
  downloadId: string,
  appID: number
) {
  const setup = get(redistributableInstalls)[downloadId];
  if (!setup) return;

  let sawBackendProgress = false;

  const onRedistributableProgress = (event: Event) => {
    const detail = (event as CustomEvent<RedistributableProgressDetail>).detail;
    if (!detail || detail.appID !== appID) return;
    if (detail.downloadId && detail.downloadId !== downloadId) return;

    sawBackendProgress = true;
    applyRedistributableProgress(downloadId, detail);
  };

  document.addEventListener(
    'app:redistributable-progress',
    onRedistributableProgress
  );

  let result: 'success' | 'failed' | 'not-found' = 'failed';
  try {
    result = await window.electronAPI.app.installRedistributables(
      appID,
      downloadId
    );
  } catch (error) {
    console.error('[setup] Redistributable installation error:', error);
    result = 'failed';
  } finally {
    document.removeEventListener(
      'app:redistributable-progress',
      onRedistributableProgress
    );
  }

  if (!sawBackendProgress) {
    const fallbackStatus = result === 'success' ? 'completed' : 'failed';
    const fallbackError =
      result === 'success'
        ? undefined
        : result === 'not-found'
          ? 'Game not found while installing redistributables'
          : 'Redistributable installation failed';

    redistributableInstalls.update((setups) => {
      const current = setups[downloadId];
      if (!current) return setups;
      return {
        ...setups,
        [downloadId]: {
          ...current,
          redistributables: current.redistributables.map((redist) => ({
            ...redist,
            status: fallbackStatus,
          })),
          overallProgress: 100,
          isComplete: true,
          error: fallbackError,
        },
      };
    });
  }

  if (result === 'success') {
    updateDownloadStatus(downloadId, {
      status: 'setup-complete',
    });

    redistributableInstalls.update((setups) => {
      delete setups[downloadId];
      return setups;
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

  redistributableInstalls.update((setups) => {
    const current = setups[downloadId];
    if (!current) return setups;
    return {
      ...setups,
      [downloadId]: {
        ...current,
        isComplete: true,
        overallProgress: 100,
        error:
          current.error ||
          (result === 'not-found'
            ? 'Game not found while installing redistributables'
            : 'Redistributable installation failed'),
      },
    };
  });

  createNotification({
    id: Math.random().toString(36).substring(2, 9),
    type: 'error',
    message: `Redistributable install failed for ${setup.gameName}.`,
  });
}

/**
 * Run setup for an app update. This only updates the version in the library file
 * without running redistributables or adding to Steam.
 */
export async function runSetupAppUpdate(
  downloadedItem: DownloadStatusAndInfo,
  outputDir: string,
  isTorrent: boolean,
  additionalData: any = {}
): Promise<SetupEventResponse> {
  const currentLibraryInfo = getApp(downloadedItem.appID);
  if (!currentLibraryInfo) {
    console.error(
      `[runSetupAppUpdate] Library entry not found for appID: ${downloadedItem.appID}`
    );
    updateDownloadStatus(downloadedItem.id, {
      status: 'error',
      error: `App not found in library (appID: ${downloadedItem.appID})`,
    });
    throw new Error(
      `App not found in library (appID: ${downloadedItem.appID})`
    );
  }

  const setupPayload = createSetupPayload(
    downloadedItem,
    outputDir,
    'update',
    currentLibraryInfo,
    additionalData
  );
  const callbacks = createSetupCallbacks(
    downloadedItem,
    'update',
    currentLibraryInfo
  );

  try {
    // Run addon setup to get the new version info
    const data: SetupEventResponse = await safeFetch(
      'setupApp',
      setupPayload,
      callbacks
    );

    // Mark setup log as inactive
    setupLogs.update((logs) => {
      if (logs[downloadedItem.id]) {
        logs[downloadedItem.id].isActive = false;
      }
      return logs;
    });

    // For updates, only update the version - don't run insertApp
    const result = await window.electronAPI.app.updateAppVersion(
      downloadedItem.appID,
      data.version,
      data.cwd,
      data.launchExecutable,
      data.launchArguments,
      downloadedItem.addonSource,
      data.umu,
      data.launchEnv
    );

    if (result === 'app-not-found') {
      updateDownloadStatus(downloadedItem.id, {
        status: 'error',
        error: 'App not found in library',
      });
      throw new Error('App not found in library');
    }

    // Remove from appUpdates state
    if (data.version === downloadedItem.updateVersion) {
      updatesManager.removeAppUpdate(downloadedItem.appID);

      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'success',
        message: `Updated ${downloadedItem.name} to version ${data.version}`,
      });
    } else {
      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'error',
        message: `Failed to update ${downloadedItem.name} to target version`,
      });
      console.log(
        'Failed to update app. Target version: ',
        data.version,
        'Current version: ',
        downloadedItem.updateVersion
      );
      updateDownloadStatus(downloadedItem.id, {
        status: 'error',
        error: `Version mismatch: expected ${downloadedItem.updateVersion}, got ${data.version}`,
      });
      return data;
    }
    const finalStatus = isTorrent ? 'seeding' : 'setup-complete';
    updateDownloadStatus(downloadedItem.id, {
      status: finalStatus,
      downloadPath: downloadedItem.downloadPath,
    });

    return data;
  } catch (error) {
    console.error('Error updating app: ', error);
    throw error;
  }
}
