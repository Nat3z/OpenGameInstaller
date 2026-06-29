import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { currentDownloads } from '@/frontend/store';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import {
  cardStatusFromHandshake,
  finalizeDownloadCard,
} from '@/frontend/lib/downloads/events';
import { safeDownloadPath, sanitizePathSegment } from '@/frontend/lib/downloads/paths';

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

    button.textContent = 'Downloading...';
    button.disabled = true;

    try {
      const handshake = await window.electronAPI.ddl.download(collectedFiles);
      currentDownloads.update((downloads) => {
        return [
          ...downloads,
          {
            id: handshake.id,
            status: cardStatusFromHandshake(handshake),
            downloadPath: safeDownloadPath(baseDir, sanitizedName),
            downloadSpeed: 0,
            progress: 0,
            appID,
            downloadSize: 0,
            queuePosition: handshake.queuePosition,
            error: handshake.error,
            ...result,
            files: persistedFiles,
          },
        ];
      });
      await finalizeDownloadCard(handshake.id);
    } catch (err) {
      console.error('Direct download error:', err);
      throw err;
    }
  }
}
