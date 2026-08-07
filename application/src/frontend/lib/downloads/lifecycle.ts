import { DownloadError, formatError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { Effect } from 'effect';
import { get } from 'svelte/store';
import { getConfigClientOption } from '@/frontend/lib/config/client';
import { resetButtonOnExit } from '@/frontend/lib/downloads/button-state';
import { ALL_SERVICES } from '@/frontend/lib/downloads/services';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import {
  createNotification,
  currentDownloads,
  type DownloadStatusAndInfo,
  setupLogs,
} from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

/**
 * Resolves download handler from config, finds the matching service, and starts the download.
 * Preserves failures for callers that need to react to whether the download started.
 * The download button is reset whenever the service exits, including defects.
 * @param result - Search result with addon and download URL/type
 * @param appID - Application ID for the download
 * @param event - Mouse event (used to resolve button if htmlButton not provided)
 * @param htmlButton - Optional button element (e.g. when called recursively)
 */
export function startDownloadEffect(
  result: SearchResultWithAddon,
  appID: number,
  event: MouseEvent | null,
  htmlButton?: HTMLButtonElement
) {
  const button =
    htmlButton ?? (event?.currentTarget as HTMLButtonElement | null);
  const resolvedButton = button instanceof HTMLButtonElement ? button : null;
  const resetButton = () => {
    if (resolvedButton) {
      resolvedButton.textContent = 'Download';
      resolvedButton.disabled = false;
    }
  };

  return resetButtonOnExit(
    Effect.gen(function* () {
      let downloadHandler: string = result.downloadType;
      if (downloadHandler === 'torrent' || downloadHandler === 'magnet') {
        const generalOptions = getConfigClientOption<{
          torrentClient?: string;
        }>('general');
        const torrentClient = generalOptions?.torrentClient ?? 'disable';
        if (torrentClient === 'disable') {
          return yield* Effect.fail(
            new DownloadError({
              message: 'Torrenting is disabled in the settings.',
            })
          );
        }
        if (
          torrentClient === 'real-debrid' ||
          torrentClient === 'all-debrid' ||
          torrentClient === 'torbox' ||
          torrentClient === 'premiumize'
        ) {
          downloadHandler = `${torrentClient}-${downloadHandler}`;
        }
      }

      const sanitizedResult = {
        ...result,
        name: result.name.replace(/[\\/:*?"<>|]/g, '-'),
      };
      const service = ALL_SERVICES.find((candidate) =>
        candidate.types.includes(downloadHandler)
      );
      logger.sync.info('Service:', service);
      if (!service) {
        return yield* Effect.fail(
          new DownloadError({
            message: `No service found for download type: ${downloadHandler}`,
          })
        );
      }

      if (resolvedButton) {
        resolvedButton.textContent = 'Downloading...';
        resolvedButton.disabled = true;
      }
      yield* service.startDownload(
        sanitizedResult,
        appID,
        event,
        resolvedButton ?? undefined
      );
    }),
    resetButton
  );
}

/** Starts a download and reports failures through the standard notification UI. */
export function startDownload(
  result: SearchResultWithAddon,
  appID: number,
  event: MouseEvent | null,
  htmlButton?: HTMLButtonElement
) {
  return startDownloadEffect(result, appID, event, htmlButton).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        logger.sync.error('startDownload failed:', error);
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: formatError(error),
        });
      })
    )
  );
}

/**
 * Updates a download's status and optional fields in the currentDownloads store.
 * @param downloadID - ID of the download to update
 * @param updates - Partial fields to merge (e.g. status, progress)
 */
export function updateDownloadStatus(
  downloadID: string,
  updates: Partial<DownloadStatusAndInfo>
) {
  currentDownloads.update((downloads) => {
    return downloads.map((download) => {
      if (download.id === downloadID) {
        const updatedDownload = {
          ...download,
          ...updates,
        } as DownloadStatusAndInfo;

        // Initialize setup logs when status changes to 'completed' (setup phase)
        if (updates.status === 'completed' && download.status !== 'completed') {
          setupLogs.update((logs) => {
            const existing = logs[downloadID];
            // Preserve logs from debrid extraction or other pre-setup work
            if (existing?.logs?.length) {
              return {
                ...logs,
                [downloadID]: {
                  ...existing,
                  isActive: true,
                },
              };
            }
            return {
              ...logs,
              [downloadID]: {
                downloadId: downloadID,
                logs: [],
                progress: 0,
                isActive: true,
              },
            };
          });
        }

        return updatedDownload;
      }
      return download;
    });
  });
}

/**
 * Returns the download item for the given ID from the store (one-time read).
 * @param downloadID - ID of the download
 * @returns The download item or undefined if not found
 */
export function getDownloadItem(
  downloadID: string
): DownloadStatusAndInfo | undefined {
  return get(currentDownloads).find((d) => d.id === downloadID);
}
