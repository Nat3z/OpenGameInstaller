import {
  createNotification,
  currentDownloads,
  setupLogs,
  type DownloadStatusAndInfo,
} from '../../store';
import { getConfigClientOption } from '../config/client';
import { ALL_SERVICES } from './services';
import type { SearchResultWithAddon } from '../tasks/runner';

export async function startDownload(
  result: SearchResultWithAddon,
  appID: number,
  event: MouseEvent | null,
  htmlButton?: HTMLButtonElement
) {
  const resolvedButton = htmlButton ?? (event?.currentTarget as HTMLButtonElement | null);
  
  let downloadHandler = result.downloadType;
  if (downloadHandler === 'torrent' || downloadHandler === 'magnet') {
    const generalOptions = getConfigClientOption('general') as any;
    const torrentClient:
      | 'webtorrent'
      | 'qbittorrent'
      | 'real-debrid'
      | 'torbox'
      | 'premiumize'
      | 'disable' =
      (generalOptions ? generalOptions.torrentClient : null) ?? 'disable';
    if (torrentClient === 'real-debrid') {
      downloadHandler = 'real-debrid-' + downloadHandler;
    } else if (torrentClient === 'torbox') {
      downloadHandler = 'torbox-' + downloadHandler;
    } else if (torrentClient === 'premiumize') {
      downloadHandler = 'premiumize-' + downloadHandler;
    } else if (torrentClient === 'disable') {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Torrenting is disabled in the settings.',
      });
      if (resolvedButton) {
        resolvedButton.textContent = 'Download';
        resolvedButton.disabled = false;
      }
      return;
    }
  }
  // replace the name's speceial characters (like amparsand, :, or any character windows doesn't support, with a dash)
  result.name = result.name.replace(/[\\/:*?"<>|]/g, '-');

  // Service-based architecture: find and delegate to the appropriate service
  const svc = ALL_SERVICES.find((s) => s.types.includes(downloadHandler));
  if (svc) {
    if (resolvedButton) {
      resolvedButton.textContent = 'Downloading...';
      resolvedButton.disabled = true;
    }
    try {
      await svc.startDownload(result, appID, event, resolvedButton ?? undefined);
    } catch (error) {
      if (resolvedButton) {
        resolvedButton.textContent = 'Download';
        resolvedButton.disabled = false;
      }
      throw error;
    }
    return;
  }

  // If no service is found for this download type, log an error
  if (resolvedButton) {
    resolvedButton.textContent = 'Download';
    resolvedButton.disabled = false;
  }
  console.error(`No service found for download type: ${downloadHandler}`);
}

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

export function getDownloadItem(
  downloadID: string
): DownloadStatusAndInfo | undefined {
  let downloadItem: DownloadStatusAndInfo | undefined;
  currentDownloads.subscribe((downloads) => {
    downloadItem = downloads.find((d) => d.id === downloadID);
  })();
  return downloadItem;
}
