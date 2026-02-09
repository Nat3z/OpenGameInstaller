import { BaseService } from './BaseService';
import { currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
/**
 * Handles standard magnet and torrent downloads via the configured torrent
 * client.
 */
export class TorrentService extends BaseService {
    types = ['torrent', 'magnet'];
    async startDownload(result, appID, event, htmlButton) {
        const button = htmlButton ?? event?.currentTarget;
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
            if (result.downloadType === 'torrent') {
                const id = await window.electronAPI.torrent.downloadTorrent(result.downloadURL, downloadPath);
                if (id === null) {
                    throw new Error('Failed to download torrent.');
                }
                currentDownloads.update((downloads) => {
                    return [
                        ...downloads,
                        {
                            ...result,
                            id,
                            status: 'downloading',
                            downloadPath,
                            downloadSpeed: 0,
                            files: [],
                            progress: 0,
                            appID,
                            downloadSize: 0,
                            originalDownloadURL: result.downloadURL, // Store original URL for resume
                        },
                    ];
                });
            }
            else if (result.downloadType === 'magnet') {
                const id = await window.electronAPI.torrent.downloadMagnet(result.downloadURL, downloadPath);
                if (id === null) {
                    throw new Error('Failed to download torrent.');
                }
                currentDownloads.update((downloads) => {
                    return [
                        ...downloads,
                        {
                            ...result,
                            id,
                            status: 'downloading',
                            downloadPath,
                            downloadSpeed: 0,
                            files: [],
                            progress: 0,
                            queuePosition: 999,
                            appID,
                            downloadSize: 0,
                            originalDownloadURL: result.downloadURL, // Store original URL for resume
                        },
                    ];
                });
            }
        }
        catch (err) {
            console.error('Torrent download error:', err);
            throw err;
        }
        finally {
            if (resolvedButton) {
                resolvedButton.textContent = 'Download';
                resolvedButton.disabled = false;
            }
        }
    }
}
//# sourceMappingURL=TorrentService.js.map