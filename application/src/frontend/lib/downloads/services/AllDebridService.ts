import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { currentDownloads, createNotification } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { listenUntilDownloadReady } from '../events';
import { updateDownloadStatus } from '../lifecycle';

/** Result shape required for AllDebrid (magnet/torrent); caller ensures these exist. */
type AllDebridSearchResult = SearchResultWithAddon & {
  downloadURL: string;
  name: string;
  filename?: string;
};

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
    _event: MouseEvent | null,
    _htmlButton?: HTMLButtonElement
  ): Promise<void> {
    console.log('Starting AllDebrid download:', result);
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

    const resolvedButton =
      _htmlButton ??
      (_event?.currentTarget instanceof HTMLButtonElement
        ? _event.currentTarget
        : null);

    const debridResult = result as AllDebridSearchResult;
    try {
      if (result.downloadType === 'magnet') {
        await this.handleAllDebridDownload(debridResult, appID, tempId, () =>
          this.getTorrentIdFromMagnet(debridResult)
        );
      } else if (result.downloadType === 'torrent') {
        await this.handleAllDebridDownload(debridResult, appID, tempId, () =>
          this.getTorrentIdFromTorrent(debridResult, resolvedButton)
        );
      }
    } catch (err) {
      console.error('Failed to start AllDebrid download:', err);
      // set the download as failed
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === tempId);
        if (!matchingDownload) return downloads;
        matchingDownload.status = 'error';
        matchingDownload.error =
          err instanceof Error
            ? err.message
            : 'Failed to start AllDebrid download.';
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });
      if (resolvedButton) {
        resolvedButton.textContent = 'Download';
        resolvedButton.disabled = false;
      }
      throw err;
    }
  }

  /** First step for magnet: add magnet and return torrent id. */
  private async getTorrentIdFromMagnet(
    result: AllDebridSearchResult
  ): Promise<string> {
    try {
      const magnetLink = await window.electronAPI.alldebrid.addMagnet(
        result.downloadURL
      );
      return magnetLink.id;
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `Failed to add magnet to AllDebrid: ${err.message}`
          : 'Failed to add magnet to AllDebrid.'
      );
    }
  }

  /** First step for torrent: validate, add torrent, and return torrent id. */
  private async getTorrentIdFromTorrent(
    result: AllDebridSearchResult,
    htmlButton?: HTMLButtonElement | null
  ): Promise<string> {
    const resetButton = () => {
      if (htmlButton) {
        htmlButton.textContent = 'Download';
        htmlButton.disabled = false;
      }
    };
    if (!result.name || !result.downloadURL) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: !result.name
          ? 'Addon did not provide a name for the torrent.'
          : 'Addon did not provide a downloadURL for the torrent.',
      });
      resetButton();
      throw new Error(
        !result.name
          ? 'Addon did not provide a name for the torrent.'
          : 'Addon did not provide a downloadURL for the torrent.'
      );
    }
    try {
      const torrent = await window.electronAPI.alldebrid.addTorrent(
        result.downloadURL
      );
      if (!torrent) {
        throw new Error('Failed to add torrent to AllDebrid.');
      }
      return torrent.id;
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `Failed to add torrent to AllDebrid: ${err.message}`
          : 'Failed to add torrent to AllDebrid.'
      );
    }
  }

  /**
   * Shared flow: wait for torrent ready, get torrent info, then either
   * single-file or multi-file download. Multi-file is on by default.
   */
  private async handleAllDebridDownload(
    result: AllDebridSearchResult,
    appID: number,
    tempId: string,
    getTorrentId: () => Promise<string>,
    options?: { multiFile?: boolean }
  ): Promise<void> {
    const torrentId = await getTorrentId();

    let isReady = await window.electronAPI.alldebrid.isTorrentReady(torrentId);
    if (!isReady) {
      window.electronAPI.alldebrid.selectTorrent();
      await waitForTorrentReady(torrentId, {
        intervalMs: 3000,
        timeoutMs: 600000,
      });
    }
    const torrentInfo =
      await window.electronAPI.alldebrid.getTorrentInfo(torrentId);

    const markError = () => {
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === tempId);
        if (!matchingDownload) return downloads;
        matchingDownload.status = 'error';
        matchingDownload.usedDebridService = 'alldebrid';
        matchingDownload.appID = appID;
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });
    };

    console.log('torrentInfo', torrentInfo, 'options', options);

    const links = torrentInfo.links;
    let resolvedLinks: string[] = [];
    createNotification({
      id: Math.random().toString(36).substring(7),
      type: 'info',
      message: 'Unrestricting AllDebrid links...',
    });
    for (const link of links) {
      const download = await window.electronAPI.alldebrid.unrestrictLink(link);
      if (!download) {
        throw new Error(
          'Failed to unrestrict the link: No response from AllDebrid.'
        );
      }
      resolvedLinks.push(download.download ?? download.link);
    }
    const safePath =
      getDownloadPath() + '/' + sanitizePathSegment(result.name) + '/';
    const { flush } = listenUntilDownloadReady();
    console.log('resolvedLinks', resolvedLinks);
    const downloadID = await window.electronAPI.ddl.download(
      resolvedLinks.map((link) => {
        const filename = decodeURIComponent(
          link.split('/').pop()?.split('?')[0] ?? 'download'
        );
        return {
          link,
          path: safePath + filename,
          headers: { 'OGI-Parallel-Limit': '1' },
        };
      })
    );
    const updatedState = flush();
    if (downloadID === null) {
      markError();
      throw new Error('Download failed to start.');
    }
    updateDownloadStatus(tempId, {
      id: downloadID,
      status: 'downloading',
      usedDebridService: 'alldebrid',
      appID: appID,
      downloadPath: safePath,
      queuePosition: updatedState[downloadID]?.queuePosition,
      files: resolvedLinks.map((link) => {
        const name = decodeURIComponent(
          link.split('/').pop()?.split('?')[0] ?? 'download'
        );
        return {
          name,
          downloadURL: link,
          headers: { 'OGI-Parallel-Limit': '1' },
        };
      }),
    });
  }
}
