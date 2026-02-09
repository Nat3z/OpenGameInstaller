import { BaseService } from './BaseService';
import { currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { listenUntilDownloadReady } from '../events';
import { sanitizePathSegment } from '../pathUtils';
/**
 * Polls until the torrent is ready or timeout/cancel. Clears interval on resolve/reject.
 */
function waitForTorrentReady(magnetId, options) {
    const intervalMs = options?.intervalMs ?? 3000;
    const timeoutMs = options?.timeoutMs ?? 600000; // 10 min default
    let intervalId = null;
    let timeoutId = null;
    const clearAll = () => {
        if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
        }
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
    };
    return new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
            clearAll();
            options?.onCancel?.();
            reject(new Error('Torrent not ready in time'));
        }, timeoutMs);
        const check = async () => {
            try {
                const isReady = await window.electronAPI.alldebrid.isTorrentReady(magnetId);
                if (isReady) {
                    clearAll();
                    resolve();
                }
            }
            catch (err) {
                clearAll();
                options?.onCancel?.();
                reject(err);
            }
        };
        intervalId = setInterval(check, intervalMs);
        check();
    });
}
/**
 * Handles magnet/torrent downloads that should be routed through AllDebrid.
 */
export class AllDebridService extends BaseService {
    types = ['all-debrid-magnet', 'all-debrid-torrent'];
    /**
     * Starts an AllDebrid download (magnet or torrent). Delegates to handleMagnetDownload or handleTorrentDownload.
     * @param result - Search result with download URL and type
     * @param appID - Application ID for the download
     * @param event - Mouse event (used to resolve button if htmlButton not provided)
     * @param htmlButton - Optional button element for consistent UX (e.g. recursive call)
     */
    async startDownload(result, appID, _event, _htmlButton) {
        if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
            return;
        const tempId = this.queueRequestDownload(result, appID, 'alldebrid');
        if (!result.downloadURL) {
            throw new Error('Addon did not provide a magnet link.');
        }
        const worked = await window.electronAPI.alldebrid.updateKey();
        if (!worked) {
            throw new Error('Please set your AllDebrid API key in the settings.');
        }
        const resolvedButton = _htmlButton ??
            (_event?.currentTarget instanceof HTMLButtonElement
                ? _event.currentTarget
                : null);
        if (result.downloadType === 'magnet') {
            await this.handleMagnetDownload(result, appID, tempId, resolvedButton);
        }
        else if (result.downloadType === 'torrent') {
            await this.handleTorrentDownload(result, appID, tempId, resolvedButton);
        }
    }
    /**
     * Adds magnet to AllDebrid, waits for readiness, then fetches link and starts ddl.download.
     */
    async handleMagnetDownload(result, appID, tempId, _htmlButton) {
        if (result.downloadType !== 'magnet')
            return;
        let magnetLink = await window.electronAPI.alldebrid.addMagnet(result.downloadURL);
        if (!magnetLink) {
            throw new Error('Failed to add magnet to AllDebrid.');
        }
        let isReady = await window.electronAPI.alldebrid.isTorrentReady(magnetLink.id);
        if (!isReady) {
            await window.electronAPI.alldebrid.selectTorrent();
            await waitForTorrentReady(magnetLink.id, {
                intervalMs: 3000,
                timeoutMs: 600000,
            });
        }
        const torrentInfo = await window.electronAPI.alldebrid.getTorrentInfo(magnetLink.id);
        if (!torrentInfo) {
            throw new Error('Failed to get torrent info from AllDebrid.');
        }
        const firstLink = torrentInfo.links[0] ?? torrentInfo.files[0]?.link;
        if (!firstLink) {
            throw new Error('No download link from AllDebrid.');
        }
        const download = await window.electronAPI.alldebrid.unrestrictLink(firstLink);
        if (!download) {
            throw new Error('Failed to unrestrict the link.');
        }
        const downloadUrl = download.download ?? download.link;
        if (!downloadUrl) {
            throw new Error('Failed to unrestrict the link.');
        }
        const safePath = getDownloadPath() +
            '/' +
            sanitizePathSegment(result.name) +
            '/' +
            sanitizePathSegment(result.filename);
        const { flush } = listenUntilDownloadReady();
        const downloadID = await window.electronAPI.ddl.download([
            { link: downloadUrl, path: safePath },
        ]);
        const updatedState = flush();
        if (downloadID === null) {
            currentDownloads.update((downloads) => {
                const matchingDownload = downloads.find((d) => d.id === tempId);
                if (!matchingDownload)
                    return downloads;
                matchingDownload.status = 'error';
                matchingDownload.usedDebridService = 'alldebrid';
                matchingDownload.appID = appID;
                downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
                return downloads;
            });
            throw new Error('Download failed to start.');
        }
        this.updateDownloadRequested(downloadID, tempId, downloadUrl, safePath, 'alldebrid', updatedState, result);
    }
    /**
     * Adds torrent to AllDebrid, waits for readiness, then fetches link and starts ddl.download.
     */
    async handleTorrentDownload(result, appID, tempId, _htmlButton) {
        if (result.downloadType !== 'torrent')
            return;
        if (!result.name) {
            throw new Error('Addon did not provide a name for the torrent.');
        }
        if (!result.downloadURL) {
            throw new Error('Addon did not provide a downloadURL for the torrent.');
        }
        let torrent = null;
        try {
            torrent = await window.electronAPI.alldebrid.addTorrent(result.downloadURL);
        }
        catch (err) {
            throw new Error(err instanceof Error
                ? `Failed to add torrent to AllDebrid: ${err.message}`
                : 'Failed to add torrent to AllDebrid.');
        }
        if (!torrent) {
            throw new Error('Failed to add torrent to AllDebrid.');
        }
        let isReady = await window.electronAPI.alldebrid.isTorrentReady(torrent.id);
        if (!isReady) {
            await window.electronAPI.alldebrid.selectTorrent();
            await waitForTorrentReady(torrent.id, {
                intervalMs: 3000,
                timeoutMs: 600000,
            });
        }
        const torrentInfo = await window.electronAPI.alldebrid.getTorrentInfo(torrent.id);
        if (!torrentInfo) {
            throw new Error('Failed to get torrent info from AllDebrid.');
        }
        const firstLink = torrentInfo.links[0] ?? torrentInfo.files[0]?.link;
        if (!firstLink) {
            throw new Error('No download link from AllDebrid.');
        }
        const download = await window.electronAPI.alldebrid.unrestrictLink(firstLink);
        if (!download) {
            throw new Error('Failed to unrestrict the link.');
        }
        const downloadUrl = download.download ?? download.link;
        if (!downloadUrl) {
            throw new Error('Failed to unrestrict the link.');
        }
        const safePath = getDownloadPath() +
            '/' +
            sanitizePathSegment(result.name) +
            '/' +
            sanitizePathSegment(result.filename);
        const { flush } = listenUntilDownloadReady();
        const downloadID = await window.electronAPI.ddl.download([
            {
                link: downloadUrl,
                path: safePath,
                headers: { 'OGI-Parallel-Limit': '1' },
            },
        ]);
        const updatedState = flush();
        if (downloadID === null) {
            currentDownloads.update((downloads) => {
                const matchingDownload = downloads.find((d) => d.id === tempId);
                if (!matchingDownload)
                    return downloads;
                matchingDownload.status = 'error';
                matchingDownload.usedDebridService = 'alldebrid';
                matchingDownload.appID = appID;
                downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
                return downloads;
            });
            throw new Error('Download failed to start.');
        }
        this.updateDownloadRequested(downloadID, tempId, downloadUrl, safePath, 'alldebrid', updatedState, result);
    }
}
//# sourceMappingURL=AllDebridService.js.map