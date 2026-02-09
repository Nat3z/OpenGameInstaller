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

    const sanitizedName = sanitizePathSegment(result.name);
    const collectedFiles = result.files.map((file) => {
      const sanitizedFileName = sanitizePathSegment(file.name);
      return {
        path: getDownloadPath() + '/' + sanitizedName + '/' + sanitizedFileName,
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
            downloadPath: getDownloadPath() + '/' + sanitizedName + '/',
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
