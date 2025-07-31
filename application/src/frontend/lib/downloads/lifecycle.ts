import type { SearchResult } from 'ogi-addon';
import {
  createNotification,
  currentDownloads,
  notifications,
  setupLogs,
  type DownloadStatusAndInfo,
} from '../../store';
import { getConfigClientOption } from '../config/client';
import { getDownloadPath } from '../core/fs';
import { safeFetch } from '../core/ipc';
import { listenUntilDownloadReady } from './events';
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
    const torrentClient: 'webtorrent' | 'qbittorrent' | 'real-debrid' =
      (generalOptions ? generalOptions.torrentClient : null) ?? 'webtorrent';
    if (torrentClient === 'real-debrid') {
      downloadType = 'real-debrid-' + downloadType;
    }
  }
  // replace the name's speceial characters (like amparsand, :, or any character windows doesn't support, with a dash)
  result.name = result.name.replace(/[\\/:*?"<>|]/g, '-');
  switch (downloadType) {
    case 'request': {
      // Create a local ID for tracking, similar to real-debrid cases
      const localID = Math.floor(Math.random() * 1000000);
      currentDownloads.update((downloads) => {
        return [
          ...downloads,
          {
            ...result,
            // changed to avoid special characters in the path and make it work with windows on wine
            id: '' + localID,
            status: 'requesting',
            downloadPath: getDownloadPath() + '/' + result.name,
            downloadSpeed: 0,
            progress: 0,
            usedRealDebrid: false,
            appID,
            downloadSize: 0,
          },
        ];
      });

      console.log('Requesting download', result);
      const response: SearchResult = await safeFetch(
        'requestDownload',
        {
          addonID: result.addonSource,
          appID: appID,
          info: JSON.parse(JSON.stringify(result)),
        },
        {
          consume: 'json',
          onFailed: (error: string) => {
            createNotification({
              id: Math.random().toString(36).substring(7),
              type: 'error',
              message: error,
            });
            currentDownloads.update((downloads) => {
              const matchingDownload = downloads.find(
                (d) => d.id === localID + ''
              )!!;
              matchingDownload.status = 'error';
              matchingDownload.error = error;
              downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
              return downloads;
            });
          },
        }
      );

      console.log('Request response:', response);

      // Merge response with original context
      const updatedResult = {
        ...response,
        addonSource: result.addonSource,
        capsuleImage: result.capsuleImage,
        coverImage: result.coverImage,
        storefront: result.storefront,
      };

      // Remove the temporary requesting download
      currentDownloads.update((downloads) => {
        return downloads.filter((d) => d.id !== localID + '');
      });

      // Reset button state before recursive call
      htmlButton.textContent = 'Downloading...';
      htmlButton.disabled = true;

      // Recursively call startDownload with the resolved result
      return await startDownload(updatedResult, appID, event);
    }
    case 'real-debrid-magnet': {
      if (!result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a magnet link.',
        });
        return;
      }
      const worked = await window.electronAPI.realdebrid.updateKey();
      if (!worked) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Please set your Real-Debrid API key in the settings.',
        });
        return;
      }
      // get the first host
      const hosts = await window.electronAPI.realdebrid.getHosts();
      const localID = Math.floor(Math.random() * 1000000);
      currentDownloads.update((downloads) => {
        return [
          ...downloads,
          {
            id: '' + localID,
            status: 'rd-downloading',
            downloadPath: getDownloadPath() + '/' + result.name,
            downloadSpeed: 0,
            usedRealDebrid: true,
            progress: 0,
            appID,
            downloadSize: 0,
            ...result,
          },
        ];
      });
      // add magnet link
      const magnetLink = await window.electronAPI.realdebrid.addMagnet(
        result.downloadURL,
        hosts[0]
      );
      const isReady = await window.electronAPI.realdebrid.isTorrentReady(
        magnetLink.id
      );
      if (!isReady) {
        window.electronAPI.realdebrid.selectTorrent(magnetLink.id);
        await new Promise<void>((resolve) => {
          const interval = setInterval(async () => {
            const isReady = await window.electronAPI.realdebrid.isTorrentReady(
              magnetLink.id
            );
            if (isReady) {
              clearInterval(interval);
              resolve();
            }
          }, 3000);
        });
      }

      const torrentInfo = await window.electronAPI.realdebrid.getTorrentInfo(
        magnetLink.id
      );
      const download = await window.electronAPI.realdebrid.unrestrictLink(
        torrentInfo.links[0]
      );

      if (download === null) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Failed to unrestrict the link.',
        });
        return;
      }

      // Temporarily register an event listener to store any download updates so that we can match our download to the correct downloadID
      const { flush } = listenUntilDownloadReady();

      const downloadID = await window.electronAPI.ddl.download([
        {
          link: download.download,
          path: getDownloadPath() + '/' + result.name + '/' + result.filename,
        },
      ]);
      const updatedState = flush();
      if (downloadID === null) {
        if (htmlButton) {
          htmlButton.textContent = 'Download';
          htmlButton.disabled = false;
        }
        currentDownloads.update((downloads) => {
          const matchingDownload = downloads.find(
            (d) => d.id === localID + ''
          )!!;
          matchingDownload.status = 'error';
          matchingDownload.usedRealDebrid = true;
          downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
          return downloads;
        });

        return;
      }
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === localID + '')!!;
        matchingDownload.status = 'downloading';
        matchingDownload.id = downloadID;
        matchingDownload.usedRealDebrid = true;

        matchingDownload.downloadPath =
          getDownloadPath() + '/' + result.name + '/';

        if (
          updatedState[downloadID] &&
          updatedState[downloadID].queuePosition
        ) {
          matchingDownload.queuePosition =
            updatedState[downloadID].queuePosition;
        }
        matchingDownload.downloadURL = download.download;
        matchingDownload.originalDownloadURL = result.downloadURL; // Store original magnet URL
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });
      break;
    }
    case 'real-debrid-torrent': {
      if (!result.name || !result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a name for the torrent.',
        });
        return;
      }

      const worked = await window.electronAPI.realdebrid.updateKey();
      if (!worked) {
        notifications.update((notifications) => [
          ...notifications,
          {
            id: Math.random().toString(36).substring(7),
            type: 'error',
            message: 'Please set your Real-Debrid API key in the settings.',
          },
        ]);
        return;
      }
      // add torrent link
      const localID = Math.floor(Math.random() * 1000000);
      currentDownloads.update((downloads) => {
        return [
          ...downloads,
          {
            id: '' + localID,
            status: 'rd-downloading',
            downloadPath: getDownloadPath() + '/' + result.name,
            downloadSpeed: 0,
            usedRealDebrid: true,
            progress: 0,
            appID,
            downloadSize: 0,
            ...result,
          },
        ];
      });
      const torrent = await window.electronAPI.realdebrid.addTorrent(
        result.downloadURL
      );
      const isReady = await window.electronAPI.realdebrid.isTorrentReady(
        torrent.id
      );
      if (!isReady) {
        window.electronAPI.realdebrid.selectTorrent(torrent.id);
        await new Promise<void>((resolve) => {
          const interval = setInterval(async () => {
            const isReady = await window.electronAPI.realdebrid.isTorrentReady(
              torrent.id
            );
            if (isReady) {
              clearInterval(interval);
              resolve();
            }
          }, 3000);
        });
      }

      const torrentInfo = await window.electronAPI.realdebrid.getTorrentInfo(
        torrent.id
      );
      // currently only supporting the first link
      const download = await window.electronAPI.realdebrid.unrestrictLink(
        torrentInfo.links[0]
      );
      if (download === null) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Failed to unrestrict the link.',
        });
        return;
      }

      // Temporarily register an event listener to store any download updates so that we can match our download to the correct downloadID

      const { flush } = listenUntilDownloadReady();
      const downloadID = await window.electronAPI.ddl.download([
        {
          link: download.download,
          path: getDownloadPath() + '/' + result.name + '/' + result.filename,
        },
      ]);
      const updatedState = flush();
      if (downloadID === null) {
        if (htmlButton) {
          htmlButton.textContent = 'Download';
          htmlButton.disabled = false;
        }
        currentDownloads.update((downloads) => {
          const matchingDownload = downloads.find(
            (d) => d.id === localID + ''
          )!!;
          matchingDownload.status = 'error';
          matchingDownload.usedRealDebrid = true;
          downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
          return downloads;
        });

        return;
      }
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === localID + '')!!;
        matchingDownload.status = 'downloading';
        matchingDownload.id = downloadID;
        matchingDownload.usedRealDebrid = true;

        matchingDownload.downloadPath =
          getDownloadPath() + '/' + result.name + '/';

        if (updatedState[downloadID]) {
          matchingDownload.queuePosition =
            updatedState[downloadID].queuePosition ?? 999;
        }
        matchingDownload.downloadURL = download.download;
        matchingDownload.originalDownloadURL = result.downloadURL; // Store original torrent URL
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });
      break;
    }
    case 'torrent': {
      if (!result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a torrent file.',
        });
        return;
      }

      // Generate a safe filename fallback for torrent files
      let filename = result.filename;
      if (!filename) {
        // Try to extract filename from URL or use a generic name
        const urlParts = result.downloadURL.split(/[\\/]/);
        const lastPart = urlParts[urlParts.length - 1];
        if (lastPart && lastPart.includes('.')) {
          filename = lastPart;
        } else {
          // Use the result name or a generic fallback
          filename = result.name || 'torrent_download';
        }
        // Sanitize filename to remove invalid characters and limit length
        filename = filename.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
      }

      const downloadPath =
        getDownloadPath() + '/' + result.name + '/' + filename;

      window.electronAPI.torrent
        .downloadTorrent(result.downloadURL, downloadPath)
        .then((id) => {
          if (id === null) {
            createNotification({
              id: Math.random().toString(36).substring(7),
              type: 'error',
              message: 'Failed to download torrent.',
            });
            console.error('No download ID returned');
            return;
          }
          htmlButton.textContent = 'Downloading...';
          htmlButton.disabled = true;
          currentDownloads.update((downloads) => {
            return [
              ...downloads,
              {
                ...result,
                id,
                status: 'downloading',
                downloadPath: getDownloadPath() + '/' + name + '/',
                downloadSpeed: 0,
                progress: 0,
                usedRealDebrid: false,
                appID,
                downloadSize: 0,
                originalDownloadURL: result.downloadURL, // Store original URL for resume
              },
            ];
          });
        });
      break;
    }

    case 'magnet': {
      if (!result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a magnet link.',
        });
        return;
      }

      // Generate a safe filename fallback for magnet links
      let filename = result.filename;
      if (!filename) {
        // For magnet links, extract name from the magnet URI or use a generic name
        const magnetMatch = result.downloadURL.match(/dn=([^&]*)/);
        if (magnetMatch) {
          filename = decodeURIComponent(magnetMatch[1]);
        } else {
          // Use the result name or a generic fallback
          filename = result.name || 'torrent_download';
        }
        // Sanitize filename to remove invalid characters and limit length
        filename = filename.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
      }

      const downloadPath =
        getDownloadPath() + '/' + result.name + '/' + filename;

      window.electronAPI.torrent
        .downloadMagnet(result.downloadURL, downloadPath)
        .then((id) => {
          if (id === null) {
            createNotification({
              id: Math.random().toString(36).substring(7),
              type: 'error',
              message: 'Failed to download torrent.',
            });
            console.error('No download ID returned');
            return;
          }
          htmlButton.textContent = 'Downloading...';
          htmlButton.disabled = true;
          currentDownloads.update((downloads) => {
            return [
              ...downloads,
              {
                id,
                status: 'downloading',
                downloadPath: getDownloadPath() + '/' + result.name + '/',
                downloadSpeed: 0,
                progress: 0,
                usedRealDebrid: false,
                queuePosition: 999,
                appID,
                downloadSize: 0,
                originalDownloadURL: result.downloadURL, // Store original URL for resume
                ...result,
              },
            ];
          });
        });
      break;
    }

    case 'direct': {
      if (!result.filename && !result.files) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a filename for the direct download.',
        });
        return;
      }

      let collectedFiles = [
        {
          path:
            getDownloadPath() +
            '/' +
            result.name +
            '/' +
            (result.filename || result.downloadURL?.split(/\\|/).pop()),
          link: result.downloadURL!!,
        },
      ];
      if (result.files) {
        collectedFiles = result.files.map((file) => {
          return {
            path: getDownloadPath() + '/' + result.name + '/' + file.name,
            link: file.downloadURL,
            // remove proxy
            headers: JSON.parse(JSON.stringify(file.headers || {})),
          };
        });
      }

      const { flush } = listenUntilDownloadReady();

      window.electronAPI.ddl.download(collectedFiles).then((id) => {
        htmlButton.textContent = 'Downloading...';
        htmlButton.disabled = true;
        const updatedState = flush();
        console.log('updatedState', updatedState);
        currentDownloads.update((downloads) => {
          return [
            ...downloads,
            {
              id,
              status: 'downloading',
              downloadPath: getDownloadPath() + '/' + result.name + '/',
              downloadSpeed: 0,
              progress: 0,
              usedRealDebrid: false,
              appID,
              downloadSize: 0,
              originalDownloadURL: result.downloadURL, // Store original URL for resume
              queuePosition: updatedState[id]?.queuePosition ?? 999,
              files: result.files, // Store files info for multi-part downloads
              ...result,
            },
          ];
        });
      });
      break;
    }
  }
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
