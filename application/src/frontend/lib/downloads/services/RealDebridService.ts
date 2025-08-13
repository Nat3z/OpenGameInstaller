import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { createNotification, currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { updateDownloadStatus } from '../../../utils';
import { listenUntilDownloadReady } from '../events';
import type { $Hosts } from 'real-debrid-js';

/**
 * Handles magnet/torrent downloads that should be routed through Real-Debrid.
 */
export class RealDebridService extends BaseService {
  readonly types = ['real-debrid-magnet', 'real-debrid-torrent'];

  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent
  ): Promise<void> {
    if (event === null) return;
    if (event.target === null) return;
    const htmlButton = event.target as HTMLButtonElement;

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
          usedDebridService: 'realdebrid',
          progress: 0,
          appID,
          downloadSize: 0,
          ...result,
        },
      ];
    });

    if (result.downloadType === 'magnet') {
      await this.handleMagnetDownload(
        result,
        appID,
        localID,
        hosts[0],
        htmlButton
      );
    } else if (result.downloadType === 'torrent') {
      await this.handleTorrentDownload(result, appID, localID, htmlButton);
    }
  }

  private async handleMagnetDownload(
    result: SearchResultWithAddon,
    appID: number,
    localID: number,
    host: $Hosts,
    htmlButton: HTMLButtonElement
  ): Promise<void> {
    // add magnet link
    const magnetLink = await window.electronAPI.realdebrid.addMagnet(
      result.downloadURL!,
      host
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
        const matchingDownload = downloads.find((d) => d.id === localID + '')!!;
        matchingDownload.status = 'error';
        matchingDownload.usedDebridService = 'realdebrid';
        matchingDownload.appID = appID;
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });

      return;
    }
    updateDownloadStatus(localID + '', {
      id: downloadID,
      status: 'downloading',
      usedDebridService: 'realdebrid',
      downloadPath: getDownloadPath() + '/' + result.name + '/',
      queuePosition: updatedState[downloadID]?.queuePosition ?? undefined,
      downloadURL: download.download,
      originalDownloadURL: result.downloadURL,
    });
  }

  private async handleTorrentDownload(
    result: SearchResultWithAddon,
    appID: number,
    localID: number,
    htmlButton: HTMLButtonElement
  ): Promise<void> {
    if (!result.name || !result.downloadURL) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Addon did not provide a name for the torrent.',
      });
      return;
    }

    // add torrent link
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
        const matchingDownload = downloads.find((d) => d.id === localID + '')!!;
        matchingDownload.status = 'error';
        matchingDownload.usedDebridService = 'realdebrid';
        matchingDownload.appID = appID;
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });

      return;
    }
    updateDownloadStatus(localID + '', {
      id: downloadID,
      status: 'downloading',
      usedDebridService: 'realdebrid',
      downloadPath: getDownloadPath() + '/' + result.name + '/',
      queuePosition: updatedState[downloadID]?.queuePosition ?? 999,
      downloadURL: download.download,
      originalDownloadURL: result.downloadURL,
    });
  }
}
