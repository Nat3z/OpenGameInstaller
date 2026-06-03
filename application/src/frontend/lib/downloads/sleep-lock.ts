import {
  currentDownloads,
  setupLogs,
  type DownloadStatusAndInfo,
  type SetupLog,
} from '@/frontend/store';
import { get } from 'svelte/store';

const BLOCKING_DOWNLOAD_STATUSES = new Set<DownloadStatusAndInfo['status']>([
  'downloading',
  'merging',
  'completed',
  'rd-downloading',
  'redistr-downloading',
  'requesting',
  'installing-redistributables',
]);

function shouldBlockSleep(
  downloads: DownloadStatusAndInfo[],
  logs: Record<string, SetupLog>
): boolean {
  for (const download of downloads) {
    if (BLOCKING_DOWNLOAD_STATUSES.has(download.status)) {
      return true;
    }
  }

  for (const log of Object.values(logs)) {
    if (log.isActive) {
      return true;
    }
  }

  return false;
}

let sleepBlockActive = false;

function syncSleepBlock(
  downloads: DownloadStatusAndInfo[],
  logs: Record<string, SetupLog>
) {
  const shouldBlock = shouldBlockSleep(downloads, logs);
  if (shouldBlock === sleepBlockActive) return;

  sleepBlockActive = shouldBlock;
  window.electronAPI.powerSave.setActive(shouldBlock).catch((error) => {
    console.error('Failed to update sleep lock:', error);
  });
}

export function initSleepLock() {
  let latestDownloads = get(currentDownloads);
  let latestSetupLogs = get(setupLogs);

  currentDownloads.subscribe((downloads) => {
    latestDownloads = downloads;
    syncSleepBlock(latestDownloads, latestSetupLogs);
  });

  setupLogs.subscribe((logs) => {
    latestSetupLogs = logs;
    syncSleepBlock(latestDownloads, latestSetupLogs);
  });

  syncSleepBlock(latestDownloads, latestSetupLogs);
}
