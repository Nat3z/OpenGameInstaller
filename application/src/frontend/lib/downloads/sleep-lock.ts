import { PlatformError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { Effect } from 'effect';
import { get } from 'svelte/store';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import {
  currentDownloads,
  type DownloadStatusAndInfo,
  type SetupLog,
  setupLogs,
} from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

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
  if (shouldBlock === sleepBlockActive) return Effect.void;

  return electronRpc.powerSave.setActive(shouldBlock).pipe(
    Effect.mapError(
      (cause) =>
        new PlatformError({
          message: `Failed to update sleep lock: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        sleepBlockActive = shouldBlock;
      })
    ),
    Effect.tapError((error) =>
      logger.error('Failed to update sleep lock:', error)
    ),
    Effect.ignore
  );
}

export function initSleepLock(
  run: (effect: Effect.Effect<void>) => void
): void {
  let latestDownloads = get(currentDownloads);
  let latestSetupLogs = get(setupLogs);

  currentDownloads.subscribe((downloads) => {
    latestDownloads = downloads;
    run(syncSleepBlock(latestDownloads, latestSetupLogs));
  });

  setupLogs.subscribe((logs) => {
    latestSetupLogs = logs;
    run(syncSleepBlock(latestDownloads, latestSetupLogs));
  });

  run(syncSleepBlock(latestDownloads, latestSetupLogs));
}
