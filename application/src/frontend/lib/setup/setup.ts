import {
  createNotification,
  setupLogs,
  protonPrefixSetups,
  type DownloadStatusAndInfo,
} from '../../store';
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
  createNotification({
    id: Math.random().toString(36).substring(2, 9),
    type: 'error',
    message: 'The addon had crashed while setting up.',
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

    // Handle the new Proton prefix setup flow for Linux with redistributables
    if (result === 'setup-prefix-required') {
      console.log(
        '[setup] Proton prefix setup required for:',
        downloadedItem.name
      );

      // Initialize the proton prefix setup state
      // The prefix path is managed by the backend (~/.ogi-wine-prefixes/{appID})
      protonPrefixSetups.update((setups) => ({
        ...setups,
        [downloadedItem.id]: {
          downloadId: downloadedItem.id,
          appID: downloadedItem.appID,
          gameName: downloadedItem.name,
          addonSource: downloadedItem.addonSource,
          redistributables: data.redistributables || [],
          step: 'added-to-steam',
          prefixPath: `~/.ogi-wine-prefixes/${downloadedItem.appID}`,
          prefixExists: false,
        },
      }));

      // Update download status to proton-prefix-setup
      updateDownloadStatus(downloadedItem.id, {
        status: 'proton-prefix-setup',
        downloadPath: downloadedItem.downloadPath,
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
    // Error flows already handled in callbacks; rethrow for callers to react if needed
    console.error('Error setting up app: ', error);
    throw error;
  }
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

    // get the original prefix before the update
    let originalPrefix = '';
    if ((await window.electronAPI.app.getOS()) === 'linux') {
      const { exists, prefixPath } =
        await window.electronAPI.app.checkPrefixExists(downloadedItem.appID);
      if (exists) {
        originalPrefix = prefixPath ?? '';
      }
    }

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
      data.launchArguments
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
        (beforeLibraryApp?.launchExecutable != data.launchExecutable ||
          beforeLibraryApp?.launchArguments != data.launchArguments)
      ) {
        let newPrefix = '';
        const { exists, prefixPath } =
          await window.electronAPI.app.checkPrefixExists(downloadedItem.appID);
        if (exists) {
          newPrefix = prefixPath ?? '';
        }

        // If the new prefix is different from the original prefix, and both are non-empty, move the prefix
        if (
          newPrefix !== originalPrefix &&
          newPrefix !== '' &&
          originalPrefix !== ''
        ) {
          // move the original prefix to the new prefix
          createNotification({
            id: Math.random().toString(36).substring(2, 9),
            type: 'success',
            message: `Swapping wine prefixes to maintain save data...`,
          });
          const result = await window.electronAPI.app.movePrefix(
            originalPrefix,
            downloadedItem.name
          );
          if (result !== 'success') {
            throw new Error('Failed to move prefix');
          }
        }
        createNotification({
          id: Math.random().toString(36).substring(2, 9),
          type: 'success',
          message: `Game configuration changed, go to the play page to re-add the game to Steam or else the game will not launch.`,
        });

        appUpdates.requiredReadds = [
          ...appUpdates.requiredReadds,
          downloadedItem.appID,
        ];
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
