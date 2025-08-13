import {
  createNotification,
  setupLogs,
  type DownloadStatusAndInfo,
} from '../../store';
import { updateDownloadStatus } from '../downloads/lifecycle';
import { saveFailedSetup } from '../recovery/failedSetups';
import type { EventListenerTypes, SetupEventResponse } from 'ogi-addon';
import { safeFetch } from '../core/ipc';

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
    multiPartFiles: JSON.parse(JSON.stringify(downloadedItem.files || [])),
    manifest: JSON.parse(JSON.stringify(downloadedItem.manifest || {})),
    ...additionalData,
  };
}

export function handleSetupError(
  error: any,
  downloadedItem: DownloadStatusAndInfo
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

  const setupData: Parameters<EventListenerTypes['setup']>[0] = {
    path: downloadedItem.downloadPath,
    type: downloadedItem.downloadType as 'direct' | 'torrent' | 'magnet',
    name: downloadedItem.name,
    usedRealDebrid: downloadedItem.usedDebridService !== undefined,
    appID: downloadedItem.appID,
    storefront: downloadedItem.storefront,
    multiPartFiles: downloadedItem.files,
    manifest: downloadedItem.manifest,
  };

  saveFailedSetup({
    downloadInfo: downloadedItem,
    setupData,
    error: error?.message || error,
    should: 'call-addon',
  });
}

export function createSetupCallbacks(downloadedItem: DownloadStatusAndInfo) {
  return {
    onLogs: (log: string[]) =>
      dispatchSetupEvent('log', downloadedItem.id, log),
    onProgress: (progress: any) =>
      dispatchSetupEvent('progress', downloadedItem.id, progress),
    onFailed: (error: any) => handleSetupError(error, downloadedItem),
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
    additionalData
  );
  const callbacks = createSetupCallbacks(downloadedItem);

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
