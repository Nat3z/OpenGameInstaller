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
import { appUpdates, updatesManager } from '../../states.svelte';
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

      // Start auto-installation in background
      startRedistributableInstallation(downloadedItem.id, downloadedItem.appID);

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

/**
 * Run setup for an app update. This only updates the version in the library file
 * without running redistributables or adding to Steam.
 */
/**
 * Start redistributable installation in background
 * Updates progress and marks complete regardless of success/failure
 */
export async function startRedistributableInstallation(
  downloadId: string,
  appID: number
) {
  const setup = get(redistributableInstalls)[downloadId];
  if (!setup) return;

  const totalRedistributables = setup.redistributables.length;

  // Install each redistributable sequentially
  for (let i = 0; i < setup.redistributables.length; i++) {
    const redist = setup.redistributables[i];

    // Update status to installing
    redistributableInstalls.update((setups) => {
      const current = setups[downloadId];
      if (!current) return setups;
      const updatedRedistributables = [...current.redistributables];
      updatedRedistributables[i] = { ...redist, status: 'installing' };
      return {
        ...setups,
        [downloadId]: {
          ...current,
          redistributables: updatedRedistributables,
          overallProgress: (i / totalRedistributables) * 100,
        },
      };
    });

    try {
      // Note: The backend installs all redistributables at once
      // We simulate progress by updating status for each item
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Mark as completed
      redistributableInstalls.update((setups) => {
        const current = setups[downloadId];
        if (!current) return setups;
        const updatedRedistributables = [...current.redistributables];
        updatedRedistributables[i] = { ...redist, status: 'completed' };
        return {
          ...setups,
          [downloadId]: {
            ...current,
            redistributables: updatedRedistributables,
            overallProgress: ((i + 1) / totalRedistributables) * 100,
          },
        };
      });
    } catch (error) {
      // Mark as failed but continue
      redistributableInstalls.update((setups) => {
        const current = setups[downloadId];
        if (!current) return setups;
        const updatedRedistributables = [...current.redistributables];
        updatedRedistributables[i] = { ...redist, status: 'failed' };
        return {
          ...setups,
          [downloadId]: {
            ...current,
            redistributables: updatedRedistributables,
            overallProgress: ((i + 1) / totalRedistributables) * 100,
          },
        };
      });
    }
  }

  // Call the backend to actually install all redistributables
  try {
    await window.electronAPI.app.installRedistributables(appID);
  } catch (error) {
    console.error('[setup] Redistributable installation error:', error);
    // Continue anyway - mark as complete regardless of failure
  }

  // Mark as complete and cleanup
  redistributableInstalls.update((setups) => {
    const current = setups[downloadId];
    if (!current) return setups;
    return {
      ...setups,
      [downloadId]: {
        ...current,
        overallProgress: 100,
        isComplete: true,
      },
    };
  });

  // Give a moment for the UI to show 100% then mark setup complete
  setTimeout(() => {
    updateDownloadStatus(downloadId, {
      status: 'setup-complete',
    });

    // Remove from tracking
    redistributableInstalls.update((setups) => {
      delete setups[downloadId];
      return setups;
    });

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'success',
      message: `Setup complete for ${setup.gameName}!`,
    });
  }, 1000);
}

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
    let beforeLibraryApp = getApp(downloadedItem.appID);
    const result = await window.electronAPI.app.updateAppVersion(
      downloadedItem.appID,
      data.version,
      data.cwd,
      data.launchExecutable,
      data.launchArguments,
      downloadedItem.addonSource
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

      if (
        (await window.electronAPI.app.getOS()) === 'linux' &&
        (beforeLibraryApp?.launchExecutable !== data.launchExecutable ||
          beforeLibraryApp?.launchArguments !== data.launchArguments ||
          beforeLibraryApp?.cwd !== data.cwd)
      ) {
        createNotification({
          id: Math.random().toString(36).substring(2, 9),
          type: 'success',
          message: `Game configuration changed, go to the play page to re-add the game to Steam or else the game will not launch.`,
        });

        // Get the current Steam app ID before marking for re-add
        const steamAppIdResult = await window.electronAPI.app.getSteamAppId(
          downloadedItem.appID
        );
        const steamAppId = steamAppIdResult.success
          ? steamAppIdResult.appId
          : undefined;

        // Only add to requiredReadds if we successfully got the Steam app ID
        if (steamAppId !== undefined) {
          appUpdates.requiredReadds = [
            ...appUpdates.requiredReadds.filter(
              (r) => r.appID !== downloadedItem.appID
            ),
            { appID: downloadedItem.appID, steamAppId },
          ];
        } else {
          console.warn(
            `[setup] Failed to get Steam app ID for app ${downloadedItem.appID}, skipping prefix migration tracking`
          );
          appUpdates.requiredReadds = appUpdates.requiredReadds.filter(
            (r) => r.appID !== downloadedItem.appID
          );
        }
      }
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
