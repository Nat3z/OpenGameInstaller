import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { currentDownloads } from '../../../store';
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
        const isReady =
          await window.electronAPI.alldebrid.isTorrentReady(magnetId);
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

  /**
   * Starts an AllDebrid download (magnet or torrent). Delegates to handleMagnetDownload or handleTorrentDownload.
   * @param result - Search result with download URL and type
   * @param appID - Application ID for the download
   * @param event - Mouse event (used to resolve button if htmlButton not provided)
   * @param htmlButton - Optional button element for consistent UX (e.g. recursive call)
   */
  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ): Promise<void> {
    if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
      return;

    const tempId = this.queueRequestDownload(result, appID, 'alldebrid');

    if (!result.downloadURL) {
      throw new Error('Addon did not provide a magnet link.');
    }

    const worked = await window.electronAPI.alldebrid.updateKey();
    if (!worked) {
      throw new Error('Please set your AllDebrid API key in the settings.');
    }

    if (result.downloadType === 'magnet') {
      await this.handleMagnetDownload(result, appID, tempId);
    } else if (result.downloadType === 'torrent') {
      await this.handleTorrentDownload(result, appID, tempId);
    }
  }

  /**
   * Adds magnet to AllDebrid, waits for readiness, then fetches link and starts ddl.download.
   */
  private async handleMagnetDownload(
    result: SearchResultWithAddon,
    appID: number,
    tempId: string
  ): Promise<void> {
    if (result.downloadType !== 'magnet') return;

    let magnetLink: { id: string; uri: string };
    try {
      magnetLink = await window.electronAPI.alldebrid.addMagnet(
        result.downloadURL!
      );
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `Failed to add magnet to AllDebrid: ${err.message}`
          : 'Failed to add magnet to AllDebrid.'
      );
    }

    let isReady = await window.electronAPI.alldebrid.isTorrentReady(
      magnetLink.id
    );
    if (!isReady) {
      window.electronAPI.alldebrid.selectTorrent();
      await waitForTorrentReady(magnetLink.id, {
        intervalMs: 3000,
        timeoutMs: 600000,
      });
    }

    const torrentInfo = await window.electronAPI.alldebrid.getTorrentInfo(
      magnetLink.id
    );
    const firstLink = torrentInfo.links[0] ?? torrentInfo.files[0]?.link;
    if (!firstLink) {
      throw new Error('No download link from AllDebrid.');
    }

    const download =
      await window.electronAPI.alldebrid.unrestrictLink(firstLink);
    const downloadUrl = download.download ?? download.link;
    if (!downloadUrl) {
      throw new Error('Failed to unrestrict the link.');
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
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === tempId);
        if (!matchingDownload) return downloads;
        matchingDownload.status = 'error';
        matchingDownload.usedDebridService = 'alldebrid';
        matchingDownload.appID = appID;
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });
      throw new Error('Download failed to start.');
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

  /**
   * Adds torrent to AllDebrid, waits for readiness, then fetches link and starts ddl.download.
   */
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

    let torrent: Awaited<
      ReturnType<typeof window.electronAPI.alldebrid.addTorrent>
    >;
    try {
      torrent = await window.electronAPI.alldebrid.addTorrent(
        result.downloadURL
      );
      if (!torrent) {
        throw new Error('Failed to add torrent to AllDebrid.');
      }
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `Failed to add torrent to AllDebrid: ${err.message}`
          : 'Failed to add torrent to AllDebrid.'
      );
    }

    let isReady = await window.electronAPI.alldebrid.isTorrentReady(torrent.id);
    if (!isReady) {
      window.electronAPI.alldebrid.selectTorrent();
      await waitForTorrentReady(torrent.id, {
        intervalMs: 3000,
        timeoutMs: 600000,
      });
    }

    const torrentInfo = await window.electronAPI.alldebrid.getTorrentInfo(
      torrent.id
    );
    const firstLink = torrentInfo.links[0] ?? torrentInfo.files[0]?.link;
    if (!firstLink) {
      throw new Error('No download link from AllDebrid.');
    }

    const download =
      await window.electronAPI.alldebrid.unrestrictLink(firstLink);
    const downloadUrl = download.download ?? download.link;
    if (!downloadUrl) {
      throw new Error('Failed to unrestrict the link.');
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
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === tempId);
        if (!matchingDownload) return downloads;
        matchingDownload.status = 'error';
        matchingDownload.usedDebridService = 'alldebrid';
        matchingDownload.appID = appID;
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });
      throw new Error('Download failed to start.');
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
}
