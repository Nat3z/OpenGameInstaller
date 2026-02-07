import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { currentDownloads } from '../../../store';
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
    event: MouseEvent,
    htmlButton?: HTMLButtonElement
  ): Promise<void> {
    if (result.downloadType !== 'direct') return;
    const button = htmlButton ?? (event?.currentTarget ?? null);
    if (event === null) return;
    if (button === null || !(button instanceof HTMLButtonElement)) return;

    if (!result.files || result.files.length === 0) {
      throw new Error('Addon did not provide files for the direct download.');
    }

    const collectedFiles = result.files.map((file) => {
      return {
        path: getDownloadPath() + '/' + result.name + '/' + file.name,
        link: file.downloadURL,
        // remove proxy
        headers: JSON.parse(JSON.stringify(file.headers || {})),
      };
    });

    const { flush } = listenUntilDownloadReady();

    button.textContent = 'Downloading...';
    button.disabled = true;

    try {
      const id = await window.electronAPI.ddl.download(collectedFiles);
      const updatedState = flush();
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
            queuePosition: updatedState[id]?.queuePosition ?? 999,
            ...result,
          },
        ];
      });
      console.log('updatedState', updatedState);
    } catch (err) {
      console.error('Direct download error:', err);
      throw err;
    }
  }
}
