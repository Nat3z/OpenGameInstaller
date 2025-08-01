import {
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
  event: MouseEvent
) {
  if (event === null) return;
  if (event.target === null) return;
  const htmlButton = event.target as HTMLButtonElement;
  htmlButton.textContent = 'Downloading...';
  htmlButton.disabled = true;
  let downloadType = result.downloadType;
  if (downloadType === 'torrent' || downloadType === 'magnet') {
    const generalOptions = getConfigClientOption('general') as any;
    const torrentClient:
      | 'webtorrent'
      | 'qbittorrent'
      | 'real-debrid'
      | 'torbox' =
      (generalOptions ? generalOptions.torrentClient : null) ?? 'webtorrent';
    if (torrentClient === 'real-debrid') {
      downloadType = 'real-debrid-' + downloadType;
    } else if (torrentClient === 'torbox') {
      downloadType = 'torbox-' + downloadType;
    }
  }
  // replace the name's speceial characters (like amparsand, :, or any character windows doesn't support, with a dash)
  result.name = result.name.replace(/[\\/:*?"<>|]/g, '-');

  // Service-based architecture: find and delegate to the appropriate service
  const svc = ALL_SERVICES.find((s) => s.types.includes(downloadType));
  if (svc) {
    await svc.startDownload(result, appID, event);
    return;
  }

  // If no service is found for this download type, log an error
  console.error(`No service found for download type: ${downloadType}`);
}

export function updateDownloadStatus(
  downloadID: string,
  updates: Partial<DownloadStatusAndInfo>
) {
  currentDownloads.update((downloads) => {
    return downloads.map((download) => {
      if (download.id === downloadID) {
        const updatedDownload = { ...download, ...updates };

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
