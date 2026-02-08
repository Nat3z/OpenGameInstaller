import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
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
    _event: MouseEvent | null,
    _htmlButton?: HTMLButtonElement
  ): Promise<void> {
    if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
      return;

    if (!result.downloadURL) {
      throw new Error('Addon did not provide a magnet link.');
    }

    const worked = await window.electronAPI.realdebrid.updateKey();
    if (!worked) {
      throw new Error('Please set your Real-Debrid API key in the settings.');
    }

    // get the first host
    const hosts = await window.electronAPI.realdebrid.getHosts();
    const tempId = this.queueRequestDownload(result, appID, 'realdebrid');

    if (result.downloadType === 'magnet') {
      await this.handleMagnetDownload(
        result,
        appID,
        tempId,
        hosts[0]
      );
    } else if (result.downloadType === 'torrent') {
      await this.handleTorrentDownload(result, appID, tempId);
    }
  }

  private async handleMagnetDownload(
    result: SearchResultWithAddon,
    appID: number,
    tempId: string,
    host: $Hosts
  ): Promise<void> {
    if (result.downloadType !== 'magnet') return;

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
      await new Promise<void>((resolve, reject) => {
        const startTime = Date.now();
        const timeout = 10 * 60 * 1000; // 10 minutes
        const interval = setInterval(async () => {
          try {
            if (Date.now() - startTime > timeout) {
              clearInterval(interval);
              reject(
                new Error(
                  'Timed out waiting for Real-Debrid torrent to be ready.'
                )
              );
              return;
            }
            const isReady = await window.electronAPI.realdebrid.isTorrentReady(
              magnetLink.id
            );
            if (isReady) {
              clearInterval(interval);
              resolve();
            }
          } catch (err) {
            clearInterval(interval);
            reject(err);
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
      throw new Error('Failed to unrestrict the link.');
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
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === tempId);
        if (!matchingDownload) return downloads;
        matchingDownload.status = 'error';
        matchingDownload.usedDebridService = 'realdebrid';
        matchingDownload.appID = appID;
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });

      throw new Error('Download failed to start.');
    }
    this.updateDownloadRequested(
      downloadID,
      tempId,
      download.download,
      getDownloadPath() + '/' + result.name + '/' + result.filename,
      'realdebrid',
      updatedState,
      result
    );
  }

  private async handleTorrentDownload(
    result: SearchResultWithAddon,
    appID: number,
    tempId: string
  ): Promise<void> {
    if (result.downloadType !== 'torrent') return;

    if (!result.name || !result.downloadURL) {
      if (!result.name) {
        throw new Error('Addon did not provide a name for the torrent.');
      }
      if (!result.downloadURL) {
        throw new Error('Addon did not provide a downloadURL for the torrent.');
      }
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
      await new Promise<void>((resolve, reject) => {
        const startTime = Date.now();
        const timeout = 10 * 60 * 1000; // 10 minutes
        const interval = setInterval(async () => {
          try {
            if (Date.now() - startTime > timeout) {
              clearInterval(interval);
              reject(
                new Error(
                  'Timed out waiting for Real-Debrid torrent to be ready.'
                )
              );
              return;
            }
            const isReady = await window.electronAPI.realdebrid.isTorrentReady(
              torrent.id
            );
            if (isReady) {
              clearInterval(interval);
              resolve();
            }
          } catch (err) {
            clearInterval(interval);
            reject(err);
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
      throw new Error('Failed to unrestrict the link.');
    }

    // Temporarily register an event listener to store any download updates so that we can match our download to the correct downloadID
    const { flush } = listenUntilDownloadReady();
    const downloadID = await window.electronAPI.ddl.download([
      {
        link: download.download,
        path: getDownloadPath() + '/' + result.name + '/' + result.filename,
        headers: {
          'OGI-Parallel-Limit': '1',
        },
      },
    ]);
    const updatedState = flush();
    if (downloadID === null) {
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === tempId);
        if (!matchingDownload) return downloads;
        matchingDownload.status = 'error';
        matchingDownload.usedDebridService = 'realdebrid';
        matchingDownload.appID = appID;
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });

      throw new Error('Download failed to start.');
    }
    this.updateDownloadRequested(
      downloadID,
      tempId,
      download.download,
      getDownloadPath() + '/' + result.name + '/' + result.filename,
      'realdebrid',
      updatedState,
      result
    );
  }
}
