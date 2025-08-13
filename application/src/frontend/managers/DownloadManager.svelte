<script lang="ts">
  import { createNotification, currentDownloads, setupLogs } from '../store';
  import { updateDownloadStatus, getDownloadItem } from '../utils';
  // no direct use of EventListenerTypes in this module anymore
  import {
    unrarAndReturnOutputDir,
    unzipAndReturnOutputDir,
  } from '../lib/setup/extraction';
  import { saveFailedSetup } from '../lib/recovery/failedSetups';
  import { runSetupApp } from '../lib/setup/setup';

  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }

  // -- Utility functions to reduce repetition --

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

  // setup flow helpers are shared in lib/setup/setup.ts

  // callbacks now come from lib/setup/setup.ts

  // payload creation now shared

  // success handling now shared in runSetupApp

  // saveFailedSetup moved to shared module

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
    if (
      !isTorrent &&
      downloadedItem.usedDebridService === 'realdebrid' &&
      !downloadedItem.files
    ) {
      // Initialize setup logs for this download
      setupLogs.update((logs) => ({
        ...logs,
        [downloadedItem.id]: {
          downloadId: downloadedItem.id,
          logs: [],
          progress: 0,
          isActive: true,
        },
      }));

      dispatchSetupEvent('log', downloadedItem.id, [
        'Extracting downloaded RAR file...',
      ]);

      const attemptUnrar = async () => {
        try {
          const rarFilePath =
            downloadedItem.downloadPath.replace(/(\/|\\)$/g, '') +
            '/' +
            downloadedItem.filename;
          const outputBase =
            downloadedItem.downloadPath.replace(/(\/|\\)$/g, '') +
            '/' +
            downloadedItem.name;
          const extractedDir = await unrarAndReturnOutputDir({
            rarFilePath,
            outputBaseDir: outputBase,
            downloadId: downloadedItem.id,
          });
          outputDir = extractedDir;
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
            type: downloadedItem.downloadType as
              | 'direct'
              | 'torrent'
              | 'magnet',
            name: downloadedItem.name,
            usedRealDebrid: downloadedItem.usedDebridService !== undefined,
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

    // handle torbox zip extraction
    if (
      downloadedItem.usedDebridService === 'torbox' &&
      !downloadedItem.files
    ) {
      // Initialize setup logs for this download
      setupLogs.update((logs) => ({
        ...logs,
        [downloadedItem.id]: {
          downloadId: downloadedItem.id,
          logs: [],
          progress: 0,
          isActive: true,
        },
      }));

      dispatchSetupEvent('log', downloadedItem.id, [
        'Extracting downloaded ZIP file...',
      ]);

      // Preserve the original ZIP file path before we mutate downloadPath
      const originalZipFilePath = downloadedItem.downloadPath;

      const attemptUnzip = async () => {
        try {
          const output = await unzipAndReturnOutputDir({
            zipFilePath: originalZipFilePath,
            outputDirBase: originalZipFilePath.replace(/\.zip$/g, ''),
            downloadId: downloadedItem.id,
          });
          if (!output) return false;
          outputDir = output;
          downloadedItem.downloadPath = outputDir;
          console.log('Newly calculated outputDir: ', outputDir);
          return true;
        } catch (error) {
          console.error('Failed to process ZIP file: ', error);
          return false;
        }
      };

      // try 3 times to extract the ZIP file
      let success = false;
      for (let i = 0; i < 3; i++) {
        try {
          success = await attemptUnzip();
          if (success) break; // if successful, break the loop
          await new Promise((resolve) => setTimeout(resolve, 1000)); // wait 1 second before retrying
        } catch (error) {
          console.log('Failed to extract ZIP file');
          console.error('Failed to process ZIP file: ', error);

          // cancel the current download
          updateDownloadStatus(downloadedItem.id, {
            status: 'error',
            error: 'Failed to process ZIP file',
          });

          saveFailedSetup({
            downloadInfo: downloadedItem,
            setupData: {
              path: downloadedItem.downloadPath,
              type: downloadedItem.downloadType as
                | 'direct'
                | 'torrent'
                | 'magnet',
              name: downloadedItem.name,
              usedRealDebrid: downloadedItem.usedDebridService !== undefined,
              appID: downloadedItem.appID,
              multiPartFiles: downloadedItem.files || [],
              storefront: downloadedItem.storefront,
              manifest: downloadedItem.manifest,
            },
            error: 'Failed to process ZIP file',
            should: 'call-unzip',
          });
        }
      }

      if (!success) {
        createNotification({
          id: Math.random().toString(36).substring(2, 9),
          type: 'error',
          message: 'Failed to extract ZIP file',
        });
        throw new Error('Failed to extract ZIP file');
      }

      // deletion handled in unzip helper
    }

    // Add multipart files data for DDL
    if (!isTorrent && downloadedItem.files) {
      additionalData.multiPartFiles = JSON.parse(
        JSON.stringify(downloadedItem.files)
      );
    }

    try {
      await runSetupApp(downloadedItem, outputDir, isTorrent, additionalData);
    } catch (error) {
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

  // -- Setup Logs from Backend --
  document.addEventListener('setup:log', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const { id: downloadID, log } = event.detail;
    console.log('Setup log from backend:', downloadID, log);

    // Update the setup logs for the given downloadID
    setupLogs.update((logs) => {
      if (logs[downloadID]) {
        const currentLogs = logs[downloadID].logs;
        const newLogs = [...currentLogs, ...log];
        // Keep only the last 100 logs to prevent memory issues
        if (newLogs.length > 100) {
          newLogs.splice(0, newLogs.length - 100);
        }
        return {
          ...logs,
          [downloadID]: {
            ...logs[downloadID],
            logs: newLogs,
          },
        };
      }
      return logs;
    });
  });

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
</script>
