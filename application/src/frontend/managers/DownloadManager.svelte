<script lang="ts">
  import {
    createNotification,
    currentDownloads,
    failedSetups,
    setupLogs,
    type DownloadStatusAndInfo,
    type FailedSetup,
  } from '../store';
  import { safeFetch, updateDownloadStatus, getDownloadItem } from '../utils';
  import type { SetupEventResponse } from 'ogi-addon';

  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }

  // -- Utility functions to reduce repetition --

  function dispatchSetupEvent(
    eventType: 'log' | 'progress',
    downloadID: string,
    data: any
  ) {
    console.log('dispatching setup event', eventType, downloadID, data);
    document.dispatchEvent(
      new CustomEvent(`setup:${eventType}`, {
        detail: {
          id: downloadID,
          [eventType === 'log' ? 'log' : 'progress']: data,
        },
      })
    );
  }

  function handleSetupError(
    error: any,
    downloadedItem: DownloadStatusAndInfo,
    setupData: any
  ) {
    console.error('Error setting up app: ', error);
    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: 'The addon had crashed while setting up.',
    });

    updateDownloadStatus(downloadedItem.id, {
      status: 'error',
      error: error.message || error,
    });

    // Mark setup log as inactive
    setupLogs.update((logs) => {
      if (logs[downloadedItem.id]) {
        logs[downloadedItem.id].isActive = false;
      }
      return logs;
    });

    saveFailedSetup({
      downloadInfo: downloadedItem,
      setupData,
      error: error.message || error,
      should: 'call-addon',
    });
  }

  function createSetupCallbacks(downloadedItem: DownloadStatusAndInfo) {
    return {
      onLogs: (log: string[]) =>
        dispatchSetupEvent('log', downloadedItem.id, log),
      onProgress: (progress: any) =>
        dispatchSetupEvent('progress', downloadedItem.id, progress),
      onFailed: (error: any) => {
        const setupData = {
          path: downloadedItem.downloadPath,
          type: downloadedItem.downloadType,
          name: downloadedItem.name,
          usedRealDebrid: downloadedItem.usedRealDebrid,
          appID: downloadedItem.appID,
          storefront: downloadedItem.storefront,
        };
        console.log('error', error);
        handleSetupError(error, downloadedItem, setupData);
      },
      consume: 'json' as const,
    };
  }

  function createSetupPayload(
    downloadedItem: DownloadStatusAndInfo,
    path: string,
    additionalData: any = {}
  ) {
    return {
      addonID: downloadedItem.addonSource,
      path,
      type: downloadedItem.downloadType,
      name: downloadedItem.name,
      usedRealDebrid: downloadedItem.usedRealDebrid,
      appID: downloadedItem.appID,
      storefront: downloadedItem.storefront,
      multiPartFiles: downloadedItem.files,
      manifest: downloadedItem.manifest,
      ...additionalData,
    };
  }

  async function handleSetupSuccess(
    data: SetupEventResponse,
    downloadedItem: DownloadStatusAndInfo,
    finalStatus: 'seeding' | 'setup-complete'
  ) {
    if (downloadedItem === undefined) return;
    if (data.redistributables && data.redistributables.length > 0) {
      // write to the downloadItem
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
      return;
    }

    updateDownloadStatus(downloadedItem.id, {
      status: finalStatus,
      downloadPath: downloadedItem.downloadPath,
    });
  }

  async function processDownloadComplete(
    downloadID: string,
    isTorrent: boolean = false
  ) {
    const downloadedItem = getDownloadItem(downloadID);
    if (!downloadedItem || downloadedItem.status === 'completed') return;

    updateDownloadStatus(downloadID, { status: 'completed' });

    let outputDir = downloadedItem.downloadPath;
    let additionalData: any = {};
    console.log('Downloaded Item: ', downloadedItem);

    // Handle torrent-specific logic
    if (isTorrent) {
      let filesInDir = await window.electronAPI.fs.getFilesInDir(outputDir);
      // keep going down the directory tree until we have something with more than one file/folder
      while (filesInDir.length === 1) {
        outputDir = outputDir + '/' + filesInDir[0];
        filesInDir = await window.electronAPI.fs.getFilesInDir(outputDir);
      }
      outputDir = outputDir + '/';
      console.log('Newly calculated outputDir: ', outputDir);
    }
    // write to the downloadItem
    downloadedItem.downloadPath = outputDir;
    updateDownloadStatus(downloadID, {
      downloadPath: outputDir,
    });

    // Handle RealDebrid extraction for DDL
    if (!isTorrent && downloadedItem.usedRealDebrid && !downloadedItem.files) {
      dispatchSetupEvent('log', downloadedItem.id, [
        'Extracting downloaded RAR file...',
      ]);

      const attemptUnrar = async () => {
        try {
          console.log('Extracting RAR file: ', downloadedItem.downloadPath);
          console.log(downloadedItem);
          const extractedDir = await window.electronAPI.fs.unrar({
            outputDir:
              downloadedItem.downloadPath.replace(/(\/|\\)$/g, '') +
              '/' +
              downloadedItem.name,
            rarFilePath:
              downloadedItem.downloadPath?.replace(/(\/|\\)$/g, '') +
              '/' +
              downloadedItem.filename,
          });
          outputDir = extractedDir;
          // delete the rar file
          console.log(
            'Deleting RAR file: ',
            downloadedItem.downloadPath?.replace(/(\/|\\)$/g, '') +
              '/' +
              downloadedItem.filename
          );
          window.electronAPI.fs.delete(
            downloadedItem.downloadPath?.replace(/(\/|\\)$/g, '') +
              '/' +
              downloadedItem.filename
          );
          console.log('RAR file deleted');
          downloadedItem.downloadPath = extractedDir;
          return true;
        } catch (error) {
          console.log('Failed to extract RAR file');
          return false;
        }
      };

      // try 3 times to extract the RAR file
      let success = false;
      for (let i = 0; i < 3; i++) {
        success = await attemptUnrar();
        if (success) break; // if successful, break the loop
        await new Promise((resolve) => setTimeout(resolve, 1000)); // wait 1 second before retrying
      }

      if (!success) {
        createNotification({
          id: Math.random().toString(36).substring(2, 9),
          type: 'error',
          message: 'Failed to extract RAR file',
        });

        // add a failed setup
        saveFailedSetup({
          downloadInfo: downloadedItem,
          setupData: {
            path: downloadedItem.downloadPath,
            type: downloadedItem.downloadType,
            name: downloadedItem.name,
            usedRealDebrid: downloadedItem.usedRealDebrid,
            appID: downloadedItem.appID,
            multiPartFiles: downloadedItem.files || [],
            storefront: downloadedItem.storefront,
            manifest: downloadedItem.manifest,
          },
          error: 'Failed to extract RAR file',
          should: 'call-unrar',
        });
        return;
      }
    }

    // Add multipart files data for DDL
    if (!isTorrent && downloadedItem.files) {
      additionalData.multiPartFiles = JSON.parse(
        JSON.stringify(downloadedItem.files)
      );
    }

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
      const finalStatus = isTorrent ? 'seeding' : 'setup-complete';
      await handleSetupSuccess(data, downloadedItem, finalStatus);
    } catch (error) {
      // already handled in the catch block of safeFetch
      console.error('Error setting up app: ', error);
    }
  }

  // -- Handles download progresses --
  function handleDownloadProgress(event: Event) {
    if (!isCustomEvent(event)) return;
    const {
      id: downloadID,
      progress,
      downloadSpeed,
      fileSize,
      queuePosition,
    } = event.detail;
    if (queuePosition > 1) {
      console.log('Queue Position Update: ', downloadID, queuePosition);
    }

    updateDownloadStatus(downloadID, {
      progress,
      downloadSpeed,
      downloadSize: fileSize,
      queuePosition,
    });
  }

  function handleDownloadCancelled(event: Event) {
    if (!isCustomEvent(event)) return;
    // remove the download from the queue
    currentDownloads.update((downloads) => {
      return downloads.filter((download) => download.id !== event.detail.id);
    });
  }

  // -- Event listeners --

  // -- Download Progress --
  document.addEventListener('ddl:download-progress', handleDownloadProgress);
  document.addEventListener(
    'torrent:download-progress',
    handleDownloadProgress
  );

  // -- Download Cancelled --
  document.addEventListener('ddl:download-cancelled', handleDownloadCancelled);
  document.addEventListener(
    'torrent:download-cancelled',
    handleDownloadCancelled
  );

  // -- Download Complete --

  document.addEventListener(
    'torrent:download-complete',
    async (event: Event) => {
      if (!isCustomEvent(event)) return;
      await processDownloadComplete(event.detail.id, true);
    }
  );

  document.addEventListener('ddl:download-complete', async (event: Event) => {
    if (!isCustomEvent(event)) return;
    await processDownloadComplete(event.detail.id, false);
  });

  // -- Download Error --

  document.addEventListener('ddl:download-error', (event: Event) => {
    if (!isCustomEvent(event)) return;
    updateDownloadStatus(event.detail.id, { status: 'error' });
  });

  // -- Download Paused/Resumed --
  // Note: Pause/Resume status updates are now handled directly in utils.ts functions
  // These events are kept for backward compatibility and additional logging
  document.addEventListener('ddl:download-paused', (event: Event) => {
    if (!isCustomEvent(event)) return;
    console.log('Direct download paused:', event.detail.id);
    // Status is already updated in pauseDownload function
  });

  document.addEventListener('ddl:download-resumed', (event: Event) => {
    if (!isCustomEvent(event)) return;
    console.log('Direct download resumed:', event.detail.id);
    // Status is already updated in resumeDownload function
  });

  document.addEventListener('torrent:download-paused', (event: Event) => {
    if (!isCustomEvent(event)) return;
    console.log('Torrent download paused:', event.detail.id);
    // Status is already updated in pauseDownload function
  });

  document.addEventListener('torrent:download-resumed', (event: Event) => {
    if (!isCustomEvent(event)) return;
    console.log('Torrent download resumed:', event.detail.id);
    // Status is already updated in resumeDownload function
  });

  // -- Failed Setup --

  function saveFailedSetup(setupInfo: {
    downloadInfo: DownloadStatusAndInfo;
    setupData: {
      path: string;
      type: string;
      name: string;
      usedRealDebrid: boolean;
      appID: number;
      multiPartFiles?: {
        name: string;
        downloadURL: string;
        headers?: Record<string, string>;
      }[];
      storefront: string;
      manifest?: Record<string, unknown>;
    };
    error: string;
    should: 'call-addon' | 'call-unrar';
  }) {
    try {
      if (!window.electronAPI.fs.exists('./failed-setups')) {
        window.electronAPI.fs.mkdir('./failed-setups');
      }

      const failedSetupId = Math.random().toString(36).substring(7);
      const failedSetupData: FailedSetup = {
        id: failedSetupId,
        timestamp: Date.now(),
        ...setupInfo,
        retryCount: 0,
      };

      window.electronAPI.fs.write(
        `./failed-setups/${failedSetupId}.json`,
        JSON.stringify(failedSetupData, null, 2)
      );

      failedSetups.update((setups) => {
        return [...setups, failedSetupData];
      });
      console.log('Saved failed setup info:', failedSetupId);
    } catch (error) {
      console.error('Failed to save setup info:', error);
    }
  }
</script>
