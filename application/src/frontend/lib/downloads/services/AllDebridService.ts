import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { createNotification, currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { listenUntilDownloadReady } from '../events';

/**
 * Handles magnet/torrent downloads that should be routed through AllDebrid.
 */
export class AllDebridService extends BaseService {
  readonly types = ['all-debrid-magnet', 'all-debrid-torrent'];

  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent
  ): Promise<void> {
    if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
      return;

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

    const worked = await window.electronAPI.alldebrid.updateKey();
    if (!worked) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Please set your AllDebrid API key in the settings.',
      });
      return;
    }

    const tempId = this.queueRequestDownload(result, appID, 'alldebrid');

    if (result.downloadType === 'magnet') {
      await this.handleMagnetDownload(result, appID, tempId, htmlButton);
    } else if (result.downloadType === 'torrent') {
      await this.handleTorrentDownload(result, appID, tempId, htmlButton);
    }
  }

  private async handleMagnetDownload(
    result: SearchResultWithAddon,
    appID: number,
    tempId: string,
    htmlButton: HTMLButtonElement
  ): Promise<void> {
    if (result.downloadType !== 'magnet') return;

    const magnetLink = await window.electronAPI.alldebrid.addMagnet(
      result.downloadURL!
    );
    let isReady = await window.electronAPI.alldebrid.isTorrentReady(
      magnetLink.id
    );
    if (!isReady) {
      window.electronAPI.alldebrid.selectTorrent();
      await new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
          isReady = await window.electronAPI.alldebrid.isTorrentReady(
            magnetLink.id
          );
          if (isReady) {
            clearInterval(interval);
            resolve();
          }
        }, 3000);
      });
    }

    const torrentInfo = await window.electronAPI.alldebrid.getTorrentInfo(
      magnetLink.id
    );
    const firstLink =
      torrentInfo.links[0] ?? torrentInfo.files[0]?.link;
    if (!firstLink) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'No download link from AllDebrid.',
      });
      this.resetButtonOnError(htmlButton, tempId, appID);
      return;
    }

    const download = await window.electronAPI.alldebrid.unrestrictLink(
      firstLink
    );
    const downloadUrl = download.download ?? download.link;
    if (!downloadUrl) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Failed to unrestrict the link.',
      });
      this.resetButtonOnError(htmlButton, tempId, appID);
      return;
    }

    const { flush } = listenUntilDownloadReady();
    const downloadID = await window.electronAPI.ddl.download([
      {
        link: downloadUrl,
        path: getDownloadPath() + '/' + result.name + '/' + result.filename,
      },
    ]);
    const updatedState = flush();
    if (downloadID === null) {
      this.resetButtonOnError(htmlButton, tempId, appID);
      return;
    }
    this.updateDownloadRequested(
      downloadID,
      tempId,
      downloadUrl,
      getDownloadPath() + '/' + result.name + '/' + result.filename,
      'alldebrid',
      updatedState,
      result
    );
  }

  private async handleTorrentDownload(
    result: SearchResultWithAddon,
    appID: number,
    tempId: string,
    htmlButton: HTMLButtonElement
  ): Promise<void> {
    if (result.downloadType !== 'torrent') return;

    if (!result.name || !result.downloadURL) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Addon did not provide a name for the torrent.',
      });
      return;
    }

    const torrent = await window.electronAPI.alldebrid.addTorrent(
      result.downloadURL
    );
    if (!torrent) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Failed to add torrent to AllDebrid.',
      });
      this.resetButtonOnError(htmlButton, tempId, appID);
      return;
    }

    let isReady = await window.electronAPI.alldebrid.isTorrentReady(
      torrent.id
    );
    if (!isReady) {
      window.electronAPI.alldebrid.selectTorrent();
      await new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
          isReady = await window.electronAPI.alldebrid.isTorrentReady(
            torrent.id
          );
          if (isReady) {
            clearInterval(interval);
            resolve();
          }
        }, 3000);
      });
    }

    const torrentInfo = await window.electronAPI.alldebrid.getTorrentInfo(
      torrent.id
    );
    const firstLink =
      torrentInfo.links[0] ?? torrentInfo.files[0]?.link;
    if (!firstLink) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'No download link from AllDebrid.',
      });
      this.resetButtonOnError(htmlButton, tempId, appID);
      return;
    }

    const download = await window.electronAPI.alldebrid.unrestrictLink(
      firstLink
    );
    const downloadUrl = download.download ?? download.link;
    if (!downloadUrl) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Failed to unrestrict the link.',
      });
      this.resetButtonOnError(htmlButton, tempId, appID);
      return;
    }

    const { flush } = listenUntilDownloadReady();
    const downloadID = await window.electronAPI.ddl.download([
      {
        link: downloadUrl,
        path: getDownloadPath() + '/' + result.name + '/' + result.filename,
        headers: { 'OGI-Parallel-Limit': '1' },
      },
    ]);
    const updatedState = flush();
    if (downloadID === null) {
      this.resetButtonOnError(htmlButton, tempId, appID);
      return;
    }
    this.updateDownloadRequested(
      downloadID,
      tempId,
      downloadUrl,
      getDownloadPath() + '/' + result.name + '/' + result.filename,
      'alldebrid',
      updatedState,
      result
    );
  }

  private resetButtonOnError(
    htmlButton: HTMLButtonElement,
    tempId: string,
    appID: number
  ): void {
    if (htmlButton) {
      htmlButton.textContent = 'Download';
      htmlButton.disabled = false;
    }
    currentDownloads.update((downloads) => {
      const matchingDownload = downloads.find((d) => d.id === tempId);
      if (!matchingDownload) return downloads;
      matchingDownload.status = 'error';
      matchingDownload.usedDebridService = 'alldebrid';
      matchingDownload.appID = appID;
      downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
      return downloads;
    });
  }
}
