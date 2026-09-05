<script lang="ts">
import type { LibraryInfo, SetupCommandData } from '@ogi-sdk/connect';
import { FileSystemError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { get } from 'svelte/store';
import type { AddonDownloadCardPayload } from '@/electron/server/addon-downloads';
import { getApp } from '@/frontend/lib/core/library';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import {
  removeFailedSetup,
  saveFailedSetup,
  savePendingRecovery,
} from '@/frontend/lib/recovery/failedSetups';
// no direct use of EventListenerTypes in this module anymore
import {
  resolveRarArchivePath,
  unrarAndReturnOutputDir,
  unzipAndReturnOutputDir,
} from '@/frontend/lib/setup/extraction';
import { runSetupApp, runSetupAppUpdate } from '@/frontend/lib/setup/setup';
import {
  createNotification,
  currentDownloads,
  type DownloadProcessingPhase,
  type DownloadStatusAndInfo,
  setupLogs,
} from '@/frontend/store.svelte';
import {
  basename,
  dirname,
  getDownloadItem,
  updateDownloadStatus,
} from '@/frontend/utils';

const logger = createLogger(LOGGER_PREFIXES.frontend);

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

function buildSetupData(item: DownloadStatusAndInfo): SetupCommandData {
  return {
    path: item.downloadPath,
    type: item.downloadType as 'direct' | 'torrent' | 'magnet',
    name: item.name,
    usedRealDebrid: item.usedDebridService !== undefined,
    clearOldFilesBeforeUpdate: item.clearOldFilesBeforeUpdate,
    appID: item.appID,
    multiPartFiles: item.files || [],
    storefront: item.storefront,
    manifest: item.manifest || {},
    ...(item.isUpdate
      ? {
          for: 'update' as const,
          currentLibraryInfo: getApp(item.appID) as LibraryInfo,
        }
      : { for: 'game' as const }),
  };
}

const processingDownloadCompletions = new Set<string>();

function shouldSkipDownloadCompleteProcessing(
  downloadID: string,
  item: DownloadStatusAndInfo
): boolean {
  if (
    processingDownloadCompletions.has(downloadID) ||
    item.status === 'setup-complete'
  ) {
    return true;
  }

  const setupLog = get(setupLogs)[downloadID];

  // Post-setup torrents stay in 'seeding' with inactive setup logs.
  if (item.status === 'seeding' && setupLog && !setupLog.isActive) {
    return true;
  }

  // Skip duplicate complete events after setup finished (inactive logs).
  // Debrid extraction also writes logs while isActive; do not skip those.
  if (
    item.status === 'completed' &&
    setupLog?.logs?.length &&
    !setupLog.isActive
  ) {
    return true;
  }

  return false;
}

async function processDownloadComplete(
  downloadID: string,
  isTorrent: boolean = false
) {
  const downloadedItem = getDownloadItem(downloadID);
  if (
    !downloadedItem ||
    shouldSkipDownloadCompleteProcessing(downloadID, downloadedItem)
  ) {
    return;
  }

  processingDownloadCompletions.add(downloadID);
  updateDownloadStatus(downloadID, {
    status: 'merging',
    progress: Number.NaN,
    downloadSpeed: 0,
    processingPhase: 'Moving files',
  });

  let outputDir = dirname(downloadedItem.downloadPath);
  // make sure that

  let originalOutputDir = outputDir;

  const shouldStageOldFiles =
    downloadedItem.isUpdate !== true ||
    downloadedItem.clearOldFilesBeforeUpdate !== false;
  let stagedOldFiles = false;
  let stagedCleanly = true;

  // Move existing files into old_files before setup unless this update opted out.
  const currentFiles = await runFrontendEffect(
    electronRpc.fs.getFilesInDir(outputDir)
  );
  const filesNotToMove = [
    ...(downloadedItem.files ?? []).map((file) => file.name),
    basename(downloadedItem.downloadPath),
    ...(isTorrent ? [basename(downloadedItem.downloadPath) + '.torrent'] : []),
    'old_files',
  ];
  const filesToMove = currentFiles.filter(
    (file) => !filesNotToMove.includes(file)
  );
  logger.sync.info('Current files: ', currentFiles);
  logger.sync.info('downloadedItem.files: ', downloadedItem.files);
  logger.sync.info('outputDir: ', outputDir);
  logger.sync.info('originalOutputDir: ', originalOutputDir);
  logger.sync.info(
    'downloadedItem.downloadPath: ',
    downloadedItem.downloadPath
  );

  if (shouldStageOldFiles && filesToMove.length > 0) {
    dispatchSetupEvent('log', downloadID, ['Moving all files to old_files']);
    await window.electronAPI.fs.mkdir(outputDir + '/old_files');
    stagedOldFiles = true;

    logger.sync.info('Files not to move: ', filesNotToMove);
    let movedCount = 0;
    for (const file of filesToMove) {
      const result = await runFrontendEffect(
        electronRpc.fs.move({
          source: outputDir + '/' + file,
          destination: outputDir + '/old_files/' + file,
        })
      );
      if (result !== 'success') {
        logger.sync.error('Failed to move file: ', file);
        stagedCleanly = false;
      }
      movedCount++;
      updateDownloadStatus(downloadID, {
        progress: movedCount / filesToMove.length,
      });
    }
    dispatchSetupEvent('log', downloadID, ['Moved all files']);
    logger.sync.info('Moved all files to old_files');
  } else if (downloadedItem.isUpdate && !shouldStageOldFiles) {
    dispatchSetupEvent('log', downloadID, [
      'Addon requested in-place update: skipping old_files backup',
    ]);
    logger.sync.info('Skipping old_files staging for update');
  }
  // Recovery files let the next launch retry from disk if the app is closed
  // during extraction or moving, instead of forcing a re-download. Skipped
  // after a dirty staging pass so a retry never runs against a directory with
  // old files half-moved into old_files. Removed once setup completes.
  const persistRecovery = (
    should: 'call-addon' | 'call-unrar' | 'call-unzip',
    path?: string
  ) => {
    if (!stagedCleanly) {
      removeFailedSetup(downloadID);
      return;
    }
    savePendingRecovery({
      downloadInfo: downloadedItem,
      setupData: {
        ...buildSetupData(downloadedItem),
        ...(path !== undefined ? { path } : {}),
      },
      should,
    });
  };

  let additionalData: any = {};
  logger.sync.info('Downloaded Item: ', downloadedItem);

  async function revertOldFiles() {
    if (!stagedOldFiles) return;
    if (!window.electronAPI.fs.exists(originalOutputDir + '/old_files')) return;
    const oldFiles = await runFrontendEffect(
      electronRpc.fs.getFilesInDir(originalOutputDir + '/old_files')
    );
    if (oldFiles.length === 0) {
      window.electronAPI.fs.delete(originalOutputDir + '/old_files');
      return;
    }
    let allMoved = true;
    for (const file of oldFiles) {
      const result = await runFrontendEffect(
        electronRpc.fs.move({
          source: originalOutputDir + '/old_files/' + file,
          destination: originalOutputDir + '/' + file,
        })
      );
      if (result !== 'success') {
        logger.sync.error('Failed to move file: ', file);
        allMoved = false;
      }
    }
    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: 'Moved files back to original directory',
    });
    // Delete the backup directory after applying it back
    if (allMoved) {
      window.electronAPI.fs.delete(originalOutputDir + '/old_files');
    }
  }

  // Handle torrent-specific logic
  if (isTorrent) {
    let filesInDir = await runFrontendEffect(
      electronRpc.fs.getFilesInDir(outputDir)
    );
    // keep going down the directory tree until we have something with more than one file/folder
    while (filesInDir.length === 1) {
      outputDir = outputDir + '/' + filesInDir[0];
      filesInDir = await runFrontendEffect(
        electronRpc.fs.getFilesInDir(outputDir)
      );
    }
    outputDir = outputDir + '/';
    logger.sync.info('Newly calculated outputDir: ', outputDir);
    // write to the downloadItem
    downloadedItem.downloadPath = outputDir;
    updateDownloadStatus(downloadID, {
      downloadPath: outputDir,
    });
  }

  // Real-Debrid / AllDebrid: extract RAR when present (skip if DDL was a non-RAR file)
  let rarArchivePath: string | null = null;
  if (
    !isTorrent &&
    (downloadedItem.usedDebridService === 'realdebrid' ||
      downloadedItem.usedDebridService === 'alldebrid')
  ) {
    try {
      rarArchivePath = await runFrontendEffect(
        resolveRarArchivePath(downloadedItem.downloadPath, downloadedItem.files)
      );
    } catch (error) {
      logger.sync.error('Failed to resolve RAR archive path:', error);
      processingDownloadCompletions.delete(downloadID);
      updateDownloadStatus(downloadID, {
        status: 'error',
        error: 'Failed to resolve RAR archive path',
      });
      return;
    }
  }

  // First recovery write, once the torrent path is normalized and the archive
  // kind is known so the retry runs the right step against the right path.
  const pendingShould = rarArchivePath
    ? ('call-unrar' as const)
    : downloadedItem.usedDebridService === 'torbox' ||
        downloadedItem.usedDebridService === 'premiumize'
      ? ('call-unzip' as const)
      : ('call-addon' as const);
  // Extraction retries resolve the archive from downloadPath; a direct addon
  // retry needs the directory the setup would have received.
  persistRecovery(
    pendingShould,
    pendingShould === 'call-addon' && !isTorrent ? outputDir : undefined
  );

  if (rarArchivePath) {
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
        const outputBase = dirname(rarArchivePath);
        const extractedDir = await runFrontendEffect(
          unrarAndReturnOutputDir({
            rarFilePath: rarArchivePath,
            outputBaseDir: outputBase,
            downloadId: downloadedItem.id,
          })
        );
        if (extractedDir === null) {
          throw new Error('RAR extraction did not return an output directory');
        }
        outputDir = extractedDir;
        downloadedItem.downloadPath = extractedDir;
        return true;
      } catch (error) {
        logger.sync.info('Failed to extract RAR file');
        return false;
      }
    };

    // try 3 times to extract the RAR file
    let success = false;
    for (let i = 0; i < 3; i++) {
      success = await attemptUnrar();
      if (success) break; // if successful, break the loop
      await runFrontendEffect(Effect.sleep(1000)); // wait before retrying
    }

    if (!success) {
      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'error',
        message: 'Failed to extract RAR file',
      });

      await revertOldFiles();
      updateDownloadStatus(downloadedItem.id, {
        status: 'error',
        error: 'Failed to extract RAR file',
      });

      // add a failed setup
      saveFailedSetup({
        downloadInfo: downloadedItem,
        setupData: buildSetupData(downloadedItem),
        error: 'Failed to extract RAR file',
        should: 'call-unrar',
      });
      processingDownloadCompletions.delete(downloadID);
      return;
    }
  }

  // handle torbox zip extraction
  if (
    downloadedItem.usedDebridService === 'torbox' ||
    downloadedItem.usedDebridService === 'premiumize'
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
        const output = await runFrontendEffect(
          unzipAndReturnOutputDir({
            zipFilePath: originalZipFilePath,
            outputDirBase: originalZipFilePath.replace(/\.zip$/g, ''),
            downloadId: downloadedItem.id,
          })
        );
        if (!output) return false;
        outputDir = output;
        downloadedItem.downloadPath = outputDir;
        logger.sync.info('Newly calculated outputDir: ', outputDir);
        return true;
      } catch (error) {
        logger.sync.error('Failed to process ZIP file: ', error);
        return false;
      }
    };

    // try 3 times to extract the ZIP file
    let success = false;
    for (let i = 0; i < 3; i++) {
      try {
        success = await attemptUnzip();
        if (success) break; // if successful, break the loop
        await runFrontendEffect(Effect.sleep(1000)); // wait before retrying
      } catch (error) {
        logger.sync.info('Failed to extract ZIP file');
        logger.sync.error('Failed to process ZIP file: ', error);
      }
    }

    if (!success) {
      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'error',
        message: 'Failed to extract ZIP file',
      });
      await revertOldFiles();
      updateDownloadStatus(downloadedItem.id, {
        status: 'error',
        error: 'Failed to extract ZIP file',
      });
      saveFailedSetup({
        downloadInfo: downloadedItem,
        setupData: buildSetupData(downloadedItem),
        error: 'Failed to process ZIP file',
        should: 'call-unzip',
      });
      processingDownloadCompletions.delete(downloadID);
      return runFrontendEffect(
        Effect.fail(
          new FileSystemError({
            message: 'Failed to extract ZIP file',
            path: originalZipFilePath,
          })
        )
      );
    }

    // deletion handled in unzip helper
  }

  // Add multipart files data for DDL
  if (!isTorrent && downloadedItem.files) {
    additionalData.multiPartFiles = JSON.parse(
      JSON.stringify(downloadedItem.files)
    );
  }

  // Extraction (if any) is done and archives are deleted, so a recovery
  // from this point on should go straight to the addon with the final path.
  persistRecovery('call-addon', outputDir);

  try {
    // Check if this is an update download and route to appropriate setup function
    updateDownloadStatus(downloadedItem.id, {
      status: 'completed',
      progress: 1,
      processingPhase: undefined,
    });
    if (downloadedItem.isUpdate) {
      await runFrontendEffect(
        runSetupAppUpdate(downloadedItem, outputDir, isTorrent, additionalData)
      );
    } else {
      await runFrontendEffect(
        runSetupApp(downloadedItem, outputDir, isTorrent, additionalData)
      );
    }
    removeFailedSetup(downloadID);

    // delete the old_files directory
    try {
      if (!stagedOldFiles) return;
      if (!window.electronAPI.fs.exists(originalOutputDir + '/old_files'))
        return;

      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'info',
        message: 'Deleting previous update files...',
      });
      window.electronAPI.fs.delete(originalOutputDir + '/old_files');
      logger.sync.info('Deleted old_files directory');
    } catch (error) {
      logger.sync.error('Failed to delete old_files directory: ', error);
    }
  } catch (error) {
    logger.sync.error('Error setting up app: ', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    dispatchSetupEvent('log', downloadedItem.id, [
      `Setup failed: ${errorMessage}`,
    ]);
    updateDownloadStatus(downloadedItem.id, {
      status: 'error',
      error: errorMessage,
    });
    await revertOldFiles();
  } finally {
    processingDownloadCompletions.delete(downloadID);
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
    part,
    totalParts,
    ratio,
    status,
    processingPhase,
  } = event.detail;
  if (queuePosition > 1) {
    logger.sync.info('Queue Position Update: ', downloadID, queuePosition);
  }

  const updates: Record<string, unknown> = {
    progress,
    downloadSpeed,
    downloadSize: fileSize,
    part,
    totalParts,
    ratio,
  };

  if (status) {
    updates.status = status;
  }
  if (processingPhase) {
    updates.processingPhase = processingPhase;
  }
  if (queuePosition !== undefined) {
    updates.queuePosition = queuePosition;
  } else if (status && status !== 'downloading' && status !== 'queued') {
    updates.queuePosition = undefined;
  }

  updateDownloadStatus(downloadID, updates);
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
document.addEventListener('torrent:download-progress', handleDownloadProgress);

document.addEventListener('processing:progress', (event: Event) => {
  if (!isCustomEvent(event)) return;
  const detail = event.detail as {
    id: string;
    phase: DownloadProcessingPhase;
    progress: number | null;
  };
  updateDownloadStatus(detail.id, {
    status: 'merging',
    processingPhase: detail.phase,
    progress: detail.progress ?? Number.NaN,
    downloadSpeed: 0,
  });
});

// -- Download Cancelled --
document.addEventListener('ddl:download-cancelled', handleDownloadCancelled);
document.addEventListener(
  'torrent:download-cancelled',
  handleDownloadCancelled
);

// -- Addon-enqueued downloads (raw files, no setup phase) --

document.addEventListener('ddl:addon-download-created', (event: Event) => {
  if (!isCustomEvent(event)) return;
  const payload = event.detail as AddonDownloadCardPayload;
  if (getDownloadItem(payload.id)) return;
  const card: DownloadStatusAndInfo = {
    downloadType: 'direct',
    id: payload.id,
    name: payload.name,
    appID: payload.appID,
    status: 'downloading',
    progress: 0,
    downloadPath: payload.downloadPath,
    files: payload.files.map((file) => ({
      name: basename(file.path),
      path: file.path,
      downloadURL: '',
    })),
    downloadSpeed: 0,
    downloadSize: 0,
    addonSource: payload.addonSource,
    capsuleImage: payload.capsuleImage,
    coverImage: payload.coverImage,
    storefront: payload.storefront,
    queuePosition: payload.queuePosition,
    totalParts: payload.totalParts,
    isAddonDownload: true,
  };
  currentDownloads.update((downloads) => [...downloads, card]);
});

// -- Download Complete --

document.addEventListener('torrent:download-complete', async (event: Event) => {
  if (!isCustomEvent(event)) return;
  await processDownloadComplete(event.detail.id, true);
});

document.addEventListener('ddl:download-complete', async (event: Event) => {
  if (!isCustomEvent(event)) return;
  // Addon-enqueued raw downloads finish here; they never enter the setup phase.
  if (getDownloadItem(event.detail.id)?.isAddonDownload) {
    updateDownloadStatus(event.detail.id, {
      status: 'setup-complete',
      progress: 1,
      downloadSpeed: 0,
      queuePosition: undefined,
    });
    return;
  }
  await processDownloadComplete(event.detail.id, false);
});

// -- Download Error --

function handleDownloadError(event: Event) {
  if (!isCustomEvent(event)) return;
  updateDownloadStatus(event.detail.id, {
    status: 'error',
    error: event.detail.error,
    queuePosition: undefined,
  });

  if (event.detail.error) {
    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: event.detail.error,
    });
  }
}

document.addEventListener('ddl:download-error', handleDownloadError);
document.addEventListener('torrent:download-error', handleDownloadError);

// -- Download Paused/Resumed --
// Note: Pause/Resume status updates are now handled directly in utils.ts functions
// These events are kept for backward compatibility and additional logging
document.addEventListener('ddl:download-paused', (event: Event) => {
  if (!isCustomEvent(event)) return;
  logger.sync.info('Direct download paused:', event.detail.id);
  // Status is already updated in pauseDownload function
});

document.addEventListener('ddl:download-resumed', (event: Event) => {
  if (!isCustomEvent(event)) return;
  logger.sync.info('Direct download resumed:', event.detail.id);
  // Status is already updated in resumeDownload function
});

document.addEventListener('torrent:download-paused', (event: Event) => {
  if (!isCustomEvent(event)) return;
  logger.sync.info('Torrent download paused:', event.detail.id);
  // Status is already updated in pauseDownload function
});

document.addEventListener('torrent:download-resumed', (event: Event) => {
  if (!isCustomEvent(event)) return;
  logger.sync.info('Torrent download resumed:', event.detail.id);
  // Status is already updated in resumeDownload function
});
</script>
