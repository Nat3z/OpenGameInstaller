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
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ): Promise<void> {
    if (result.downloadType !== 'direct') return;
    const button = htmlButton ?? (event?.currentTarget ?? null);
    if (button === null || !(button instanceof HTMLButtonElement)) return;

    if (!result.files || result.files.length === 0) {
      throw new Error('Addon did not provide files for the direct download.');
    }

    const downloadPath = getDownloadPath() + '/' + result.name + '/';
    const collectedFiles = result.files.map((file) => {
      return {
        path: downloadPath + file.name,
        link: file.downloadURL,
        // remove proxy
        headers: JSON.parse(JSON.stringify(file.headers || {})),
      };
    });

    const { flush } = listenUntilDownloadReady();

    const originalText = button.textContent ?? '';
    const originalDisabled = button.disabled;
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
            downloadPath,
            downloadSpeed: 0,
            progress: 0,
            appID,
            downloadSize: 0,
            queuePosition: updatedState[id]?.queuePosition ?? 999,
            ...result,
          },
        ];
      });
    } catch (err) {
      console.error('Direct download error:', err);
      throw err;
    } finally {
      button.textContent = originalText;
      button.disabled = originalDisabled;
    }
  }
}
