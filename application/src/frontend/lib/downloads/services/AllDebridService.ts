import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { createNotification, currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { listenUntilDownloadReady } from '../events';

/**
 * Sanitizes a path segment (e.g. result.name or result.filename) to prevent path traversal
 * and invalid characters. Returns a safe basename-like segment.
 */
function sanitizePathSegment(segment: string | undefined | null): string {
  if (segment == null || segment === '') return 'download';
  // Take last path component and strip path separators and ..
  const normalized = segment.replace(/[/\\]+/g, '/').replace(/\.\./g, '');
  const parts = normalized.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? 'download';
  return last.replace(/[\0<>:"|?*]/g, '_').substring(0, 255) || 'download';
}

/**
 * Polls until the torrent is ready or timeout/cancel. Clears interval on resolve/reject.
 */
function waitForTorrentReady(
  magnetId: string,
  options?: { intervalMs?: number; timeoutMs?: number; onCancel?: () => void }
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 3000;
  const timeoutMs = options?.timeoutMs ?? 600000; // 10 min default
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const clearAll = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      clearAll();
      options?.onCancel?.();
      reject(new Error('Torrent not ready in time'));
    }, timeoutMs);

    const check = async () => {
      try {
        const isReady = await window.electronAPI.alldebrid.isTorrentReady(
          magnetId
        );
        if (isReady) {
          clearAll();
          resolve();
        }
      } catch (err) {
        clearAll();
        options?.onCancel?.();
        reject(err);
      }
    };

    intervalId = setInterval(check, intervalMs);
    check();
  });
}

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
    if (
      event.currentTarget === null ||
      !(event.currentTarget instanceof HTMLButtonElement)
    )
      return;
    const htmlButton = event.currentTarget;

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

    let magnetLink: { id: string; uri: string };
    try {
      magnetLink = await window.electronAPI.alldebrid.addMagnet(
        result.downloadURL!
      );
    } catch (err) {
      this.resetButtonOnError(htmlButton, tempId, appID);
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message:
          err instanceof Error
            ? `Failed to add magnet to AllDebrid: ${err.message}`
            : 'Failed to add magnet to AllDebrid.',
      });
      return;
    }

    let isReady = await window.electronAPI.alldebrid.isTorrentReady(
      magnetLink.id
    );
    if (!isReady) {
      window.electronAPI.alldebrid.selectTorrent();
      try {
        await waitForTorrentReady(magnetLink.id, {
          intervalMs: 3000,
          timeoutMs: 600000,
        });
      } catch (err) {
        this.resetButtonOnError(htmlButton, tempId, appID);
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message:
            err instanceof Error && err.message === 'Torrent not ready in time'
              ? 'Torrent not ready in time.'
              : err instanceof Error
                ? err.message
                : 'Torrent readiness check failed.',
        });
        return;
      }
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

    const safePath =
      getDownloadPath() +
      '/' +
      sanitizePathSegment(result.name) +
      '/' +
      sanitizePathSegment(result.filename);
    const { flush } = listenUntilDownloadReady();
    const downloadID = await window.electronAPI.ddl.download([
      { link: downloadUrl, path: safePath },
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
      safePath,
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
      try {
        await waitForTorrentReady(torrent.id, {
          intervalMs: 3000,
          timeoutMs: 600000,
        });
      } catch (err) {
        this.resetButtonOnError(htmlButton, tempId, appID);
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message:
            err instanceof Error && err.message === 'Torrent not ready in time'
              ? 'Torrent not ready in time.'
              : err instanceof Error
                ? err.message
                : 'Torrent readiness check failed.',
        });
        return;
      }
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

    const safePath =
      getDownloadPath() +
      '/' +
      sanitizePathSegment(result.name) +
      '/' +
      sanitizePathSegment(result.filename);
    const { flush } = listenUntilDownloadReady();
    const downloadID = await window.electronAPI.ddl.download([
      {
        link: downloadUrl,
        path: safePath,
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
      safePath,
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
