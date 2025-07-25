<script lang="ts">
  import type { LibraryInfo } from 'ogi-addon';
  import {
    createNotification,
    currentDownloads,
    failedSetups,
    type DownloadStatusAndInfo,
  } from '../store';
  import { getDownloadPath, safeFetch } from '../utils';

  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }

  // -- Utility functions to reduce repetition --

  function updateDownloadStatus(
    downloadID: string,
    updates: Partial<DownloadStatusAndInfo>
  ) {
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          return { ...download, ...updates };
        }
        return download;
      });
    });
  }

  function getDownloadItem(
    downloadID: string
  ): DownloadStatusAndInfo | undefined {
    let foundItem: DownloadStatusAndInfo | undefined;
    currentDownloads.update((downloads) => {
      return downloads.map((download) => {
        if (download.id === downloadID) {
          foundItem = download;
          return download;
        }
        return download;
      });
    });
    return foundItem;
  }

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

    saveFailedSetup({
      downloadInfo: downloadedItem,
      setupData,
      error: error.message || error,
      timestamp: Date.now(),
    });
  }

  function createSetupCallbacks(downloadedItem: DownloadStatusAndInfo) {
    return {
      onLogs: (log: any) => dispatchSetupEvent('log', downloadedItem.id, log),
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
      ...additionalData,
    };
  }

  async function handleSetupSuccess(
    data: Omit<
      LibraryInfo,
      | 'capsuleImage'
      | 'coverImage'
      | 'name'
      | 'appID'
      | 'storefront'
      | 'addonsource'
    >,
    downloadedItem: DownloadStatusAndInfo,
    finalStatus: 'seeding' | 'setup-complete'
  ) {
    if (downloadedItem === undefined) return;
    window.electronAPI.app.insertApp({
      ...data,
      capsuleImage: downloadedItem.capsuleImage,
      coverImage: downloadedItem.coverImage,
      name: downloadedItem.name,
      appID: downloadedItem.appID,
      storefront: downloadedItem.storefront,
      addonsource: downloadedItem.addonSource,
    });
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
    if (!downloadedItem) return;

    updateDownloadStatus(downloadID, { status: 'completed' });

    let outputDir = downloadedItem.downloadPath;
    let additionalData: any = {};

    // Handle torrent-specific logic
    if (isTorrent && outputDir.endsWith('.torrent')) {
      const filesInDir = await window.electronAPI.fs.getFilesInDir(outputDir);
      if (filesInDir.length === 1) {
        outputDir = downloadedItem.downloadPath + '\\' + filesInDir[0] + '\\';
        console.log('Newly calculated outputDir: ', outputDir);
      } else {
        console.error(
          'Error: More than one file in the directory, cannot determine the output directory.'
        );
      }
    }

    // Handle RealDebrid extraction for DDL
    if (!isTorrent && downloadedItem.usedRealDebrid && !downloadedItem.files) {
      dispatchSetupEvent('log', downloadedItem.id, [
        'Extracting downloaded RAR file...',
      ]);
      const extractedDir = await window.electronAPI.fs.unrar({
        outputDir: getDownloadPath() + '/' + downloadedItem.filename,
        rarFilePath: downloadedItem.downloadPath,
      });
      outputDir = extractedDir;
      downloadedItem.downloadPath = extractedDir;
    }

    // Add multipart files data for DDL
    if (!isTorrent) {
      additionalData.multiPartFiles = downloadedItem.files;
    }

    const setupPayload = createSetupPayload(
      downloadedItem,
      outputDir,
      additionalData
    );
    const callbacks = createSetupCallbacks(downloadedItem);

    try {
      const data: LibraryInfo = await safeFetch(
        'setupApp',
        setupPayload,
        callbacks
      );
      const finalStatus = isTorrent ? 'seeding' : 'setup-complete';
      await handleSetupSuccess(data, downloadedItem, finalStatus);
    } catch (error) {
      const setupData = {
        path: outputDir,
        type: downloadedItem.downloadType,
        name: downloadedItem.name,
        usedRealDebrid: downloadedItem.usedRealDebrid,
        appID: downloadedItem.appID,
        storefront: downloadedItem.storefront,
        ...(additionalData.multiPartFiles && {
          multiPartFiles: additionalData.multiPartFiles,
        }),
      };
      handleSetupError(error, downloadedItem, setupData);
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

  // -- Failed Setup --

  function saveFailedSetup(setupInfo: any) {
    try {
      if (!window.electronAPI.fs.exists('./failed-setups')) {
        window.electronAPI.fs.mkdir('./failed-setups');
      }

      const failedSetupId = Math.random().toString(36).substring(7);
      const failedSetupData = {
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
