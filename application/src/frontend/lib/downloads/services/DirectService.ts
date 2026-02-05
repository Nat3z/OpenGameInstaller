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
    event: MouseEvent,
    htmlButton?: HTMLButtonElement
  ): Promise<void> {
    if (result.downloadType !== 'direct') return;
    const button = htmlButton ?? (event?.currentTarget ?? null);
    if (event === null) return;
    if (button === null || !(button instanceof HTMLButtonElement)) return;
    const resolvedButton = button;

    if (!result.files || result.files.length === 0) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Addon did not provide files for the direct download.',
      });
      return;
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

    resolvedButton.textContent = 'Downloading...';
    resolvedButton.disabled = true;
    window.electronAPI.ddl
      .download(collectedFiles)
      .then((id) => {
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
      })
      .catch((err) => {
        console.error('Direct download error:', err);
        resolvedButton.textContent = 'Download';
        resolvedButton.disabled = false;
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: err instanceof Error ? err.message : 'Direct download failed.',
        });
      });
  }
}
