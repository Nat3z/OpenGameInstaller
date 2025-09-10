import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { createNotification, currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { listenUntilDownloadReady } from '../events';

/**
 * Handles simple direct file downloads (single or multi-part).
 */
export class DirectService extends BaseService {
  readonly types = ['direct'];

  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent
  ): Promise<void> {
    if (event === null) return;
    if (event.target === null) return;
    const htmlButton = event.target as HTMLButtonElement;

    if (!result.filename && !result.files) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Addon did not provide a filename for the direct download.',
      });
      return;
    }

    const deriveFilenameFromUrl = (url?: string): string | undefined => {
      if (!url) return undefined;
      try {
        const u = new URL(url);
        const last = u.pathname.split('/').pop();
        return last && last.length > 0 ? decodeURIComponent(last) : undefined;
      } catch (e) {
        const parts = url.split(/[\\\/]/);
        return parts.length > 0 ? parts[parts.length - 1] : undefined;
      }
    };

    const singleFilename =
      result.filename ||
      deriveFilenameFromUrl(result.downloadURL) ||
      'download';

    let collectedFiles = [
      {
        path: getDownloadPath() + '/' + result.name + '/' + singleFilename,
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
            appID,
            downloadSize: 0,
            originalDownloadURL: result.downloadURL, // Store original URL for resume
            queuePosition: updatedState[id]?.queuePosition ?? 999,
            files: result.files, // Store files info for multi-part downloads
            // Ensure filename is persisted for consistent restarts
            filename: result.filename || singleFilename,
            ...result,
          },
        ];
      });
    });
  }
}
