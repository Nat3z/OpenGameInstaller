import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { createNotification, currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';

/**
 * Handles standard magnet and torrent downloads via the configured torrent
 * client.
 */
export class TorrentService extends BaseService {
  readonly types = ['torrent', 'magnet'];

  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent
  ): Promise<void> {
    if (event === null) return;
    if (
      event.currentTarget === null ||
      !(event.currentTarget instanceof HTMLButtonElement)
    )
      return;
    if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
      return;

    const htmlButton = event.currentTarget;

    if (!result.downloadURL) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: `Addon did not provide a ${result.downloadType} file.`,
      });
      return;
    }

    // Generate a safe filename fallback for torrent files
    let filename = result.filename;
    if (!filename) {
      if (result.downloadType === 'magnet') {
        // For magnet links, extract name from the magnet URI or use a generic name
        const magnetMatch = result.downloadURL.match(/dn=([^&]*)/);
        if (magnetMatch) {
          filename = decodeURIComponent(magnetMatch[1]);
        } else {
          // Use the result name or a generic fallback
          filename = result.name || 'torrent_download';
        }
      } else {
        // For torrent files, try to extract filename from URL
        const urlParts = result.downloadURL.split(/[\\/]/);
        const lastPart = urlParts[urlParts.length - 1];
        if (lastPart && lastPart.includes('.')) {
          filename = lastPart;
        } else {
          // Use the result name or a generic fallback
          filename = result.name || 'torrent_download';
        }
      }
      // Sanitize filename to remove invalid characters and limit length
      filename = filename.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
    }

    const downloadPath = getDownloadPath() + '/' + result.name + '/' + filename;

    if (result.downloadType === 'torrent') {
      window.electronAPI.torrent
        .downloadTorrent(result.downloadURL, downloadPath)
        .then((id) => {
          if (id === null) {
            createNotification({
              id: Math.random().toString(36).substring(7),
              type: 'error',
              message: 'Failed to download torrent.',
            });
            console.error('No download ID returned');
            return;
          }
          htmlButton.textContent = 'Downloading...';
          htmlButton.disabled = true;
          currentDownloads.update((downloads) => {
            return [
              ...downloads,
              {
                ...result,
                id,
                status: 'downloading',
                downloadPath: getDownloadPath() + '/' + result.name + '/',
                downloadSpeed: 0,
                files: [],
                progress: 0,
                appID,
                downloadSize: 0,
                originalDownloadURL: result.downloadURL, // Store original URL for resume
              },
            ];
          });
        });
    } else if (result.downloadType === 'magnet') {
      window.electronAPI.torrent
        .downloadMagnet(result.downloadURL, downloadPath)
        .then((id) => {
          if (id === null) {
            createNotification({
              id: Math.random().toString(36).substring(7),
              type: 'error',
              message: 'Failed to download torrent.',
            });
            console.error('No download ID returned');
            return;
          }
          htmlButton.textContent = 'Downloading...';
          htmlButton.disabled = true;
          currentDownloads.update((downloads) => {
            return [
              ...downloads,
              {
                id,
                status: 'downloading',
                downloadPath: getDownloadPath() + '/' + result.name + '/',
                downloadSpeed: 0,
                files: [],
                progress: 0,
                queuePosition: 999,
                appID,
                downloadSize: 0,
                originalDownloadURL: result.downloadURL, // Store original URL for resume
                ...result,
              },
            ];
          });
        });
    }
  }
}
