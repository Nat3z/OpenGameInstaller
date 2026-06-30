import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { currentDownloads } from '@/frontend/store.svelte';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import { listenUntilDownloadReady } from '@/frontend/lib/downloads/events';
import {
  safeDownloadPath,
  sanitizePathSegment,
} from '@/frontend/lib/downloads/paths';

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
    const button = htmlButton ?? event?.currentTarget ?? null;
    if (button === null || !(button instanceof HTMLButtonElement)) return;

    if (!result.files || result.files.length === 0) {
      throw new Error('Addon did not provide files for the direct download.');
    }

    const baseDir = getDownloadPath();
    const sanitizedName = sanitizePathSegment(result.name);
    const collectedFiles = result.files.map((file) => {
      const sanitizedFileName = sanitizePathSegment(file.name);
      return {
        path: safeDownloadPath(baseDir, sanitizedName, sanitizedFileName),
        link: file.downloadURL,
        headers: JSON.parse(JSON.stringify(file.headers || {})),
      };
    });
    const persistedFiles = result.files.map((file, i) => ({
      name: sanitizePathSegment(file.name),
      path: collectedFiles[i].path,
      downloadURL: file.downloadURL,
      headers: collectedFiles[i].headers,
    }));

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
            status: updatedState[id]?.error ? 'error' : 'downloading',
            downloadPath: safeDownloadPath(baseDir, sanitizedName),
            downloadSpeed: 0,
            progress: 0,
            appID,
            downloadSize: 0,
            queuePosition: updatedState[id]?.queuePosition,
            error: updatedState[id]?.error,
            ...result,
            files: persistedFiles,
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
