import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { currentDownloads } from '@/frontend/store';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import {
  cardStatusFromHandshake,
  finalizeDownloadCard,
} from '@/frontend/lib/downloads/events';

/**
 * Handles standard magnet and torrent downloads via the configured torrent
 * client.
 */
export class TorrentService extends BaseService {
  readonly types = ['torrent', 'magnet'];

  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ): Promise<void> {
    const button =
      htmlButton ?? (event?.currentTarget as HTMLButtonElement | null);
    const resolvedButton = button instanceof HTMLButtonElement ? button : null;

    if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
      return;

    if (!result.downloadURL) {
      throw new Error(`Addon did not provide a ${result.downloadType} file.`);
    }

    const downloadPath = getDownloadPath() + '/' + result.name + '/';

    if (resolvedButton) {
      resolvedButton.textContent = 'Downloading...';
      resolvedButton.disabled = true;
    }

    try {
      const handshake =
        result.downloadType === 'torrent'
          ? await window.electronAPI.torrent.downloadTorrent(
              result.downloadURL,
              downloadPath
            )
          : await window.electronAPI.torrent.downloadMagnet(
              result.downloadURL,
              downloadPath
            );

      currentDownloads.update((downloads) => {
        return [
          ...downloads,
          {
            ...result,
            id: handshake.id,
            status: cardStatusFromHandshake(handshake),
            downloadPath: getDownloadPath() + '/' + result.name + '/',
            downloadSpeed: 0,
            files: [],
            progress: 0,
            queuePosition: handshake.queuePosition,
            error: handshake.error,
            appID,
            downloadSize: 0,
            originalDownloadURL: result.downloadURL,
          },
        ];
      });
      await finalizeDownloadCard(handshake.id);
    } catch (err) {
      console.error('Torrent download error:', err);
      throw err;
    } finally {
      if (resolvedButton) {
        resolvedButton.textContent = 'Download';
        resolvedButton.disabled = false;
      }
    }
  }
}
