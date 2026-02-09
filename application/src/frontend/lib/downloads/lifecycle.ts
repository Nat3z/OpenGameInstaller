import {
  createNotification,
  currentDownloads,
  setupLogs,
  type DownloadStatusAndInfo,
} from '../../store';
import { get } from 'svelte/store';
import { getConfigClientOption } from '../config/client';
import { ALL_SERVICES } from './services';
import type { SearchResultWithAddon } from '../tasks/runner';

/**
 * Resolves download handler from config, finds the matching service, and starts the download.
 * Resets the button and notifies on failure if startDownload throws.
 * @param result - Search result with addon and download URL/type
 * @param appID - Application ID for the download
 * @param event - Mouse event (used to resolve button if htmlButton not provided)
 * @param htmlButton - Optional button element (e.g. when called recursively)
 */
export async function startDownload(
  result: SearchResultWithAddon,
  appID: number,
  event: MouseEvent | null,
  htmlButton?: HTMLButtonElement
) {
  const button = htmlButton ?? (event?.currentTarget as HTMLButtonElement | null);
  const resolvedButton = (button instanceof HTMLButtonElement) ? button : null;

  const resetButton = () => {
    if (resolvedButton) {
      resolvedButton.textContent = 'Download';
      resolvedButton.disabled = false;
    }
  };

  let downloadHandler = result.downloadType;
  if (downloadHandler === 'torrent' || downloadHandler === 'magnet') {
    const generalOptions = getConfigClientOption('general') as any;
    const torrentClient:
      | 'webtorrent'
      | 'qbittorrent'
      | 'real-debrid'
      | 'all-debrid'
      | 'torbox'
      | 'premiumize'
      | 'disable' =
      (generalOptions ? generalOptions.torrentClient : null) ?? 'disable';
    
    if (torrentClient === 'disable') {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Torrenting is disabled in the settings.',
      });
      resetButton();
      return;
    }
    
    if (torrentClient === 'real-debrid') {
      downloadHandler = 'real-debrid-' + downloadHandler;
    } else if (torrentClient === 'all-debrid') {
      downloadHandler = 'all-debrid-' + downloadHandler;
    } else if (torrentClient === 'torbox') {
      downloadHandler = 'torbox-' + downloadHandler;
    } else if (torrentClient === 'premiumize') {
      downloadHandler = 'premiumize-' + downloadHandler;
    }
  }

  // Replace special characters (e.g. ampersand, colon, or any character Windows doesn't support) with a dash
  const sanitizedResult = {
    ...result,
    name: result.name.replace(/[\\/:*?"<>|&]/g, '-'),
  };

  // Service-based architecture: find and delegate to the appropriate service
  const svc = ALL_SERVICES.find((s) => s.types.includes(downloadHandler));
  if (!svc) {
    // If no service is found for this download type, log an error and reset button
    console.error(`No service found for download type: ${downloadHandler}`);
    resetButton();
    return;
  }

  // Set button state only after confirming a service exists
  if (resolvedButton) {
    resolvedButton.textContent = 'Downloading...';
    resolvedButton.disabled = true;
  }

  try {
    await svc.startDownload(sanitizedResult, appID, event, resolvedButton ?? undefined);
  } catch (err) {
    resetButton();
    console.error('startDownload failed:', err);
    createNotification({
      id: Math.random().toString(36).substring(7),
      type: 'error',
      message: err instanceof Error ? err.message : 'Download failed.',
    });
  }
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
          setupLogs.update((logs) => ({
            ...logs,
            [downloadID]: {
              downloadId: downloadID,
              logs: [],
              progress: 0,
              isActive: true,
            },
          }));
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
