import { BaseService } from './BaseService';
import { currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { listenUntilDownloadReady } from '../events';
import { sanitizePathSegment } from '../pathUtils';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/**
 * Handles magnet/torrent downloads that should be routed through Real-Debrid.
 */
export class RealDebridService extends BaseService {
    types = ['real-debrid-magnet', 'real-debrid-torrent'];
    async pollUntilReady(id) {
        const startTime = Date.now();
        while (true) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            if (Date.now() - startTime >= POLL_TIMEOUT_MS) {
                throw new Error('Timed out waiting for Real-Debrid torrent to be ready.');
            }
            const ready = await window.electronAPI.realdebrid.isTorrentReady(id);
            if (ready)
                break;
        }
    }
    async startDownload(result, appID, _event, _htmlButton) {
        if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
            return;
        if (!result.downloadURL) {
            throw new Error('Addon did not provide a magnet link.');
        }
        const worked = await window.electronAPI.realdebrid.updateKey();
        if (!worked) {
            throw new Error('Please set your Real-Debrid API key in the settings.');
        }
        const hosts = await window.electronAPI.realdebrid.getHosts();
        if (!hosts || hosts.length === 0) {
            throw new Error('No Real-Debrid hosts available.');
        }
        const tempId = this.queueRequestDownload(result, appID, 'realdebrid');
        if (result.downloadType === 'magnet') {
            await this.handleMagnetDownload(result, appID, tempId, hosts[0]);
        }
        else if (result.downloadType === 'torrent') {
            await this.handleTorrentDownload(result, appID, tempId);
        }
    }
    async handleMagnetDownload(result, appID, tempId, host) {
        if (result.downloadType !== 'magnet')
            return;
        // add magnet link
        const magnetLink = await window.electronAPI.realdebrid.addMagnet(result.downloadURL, host);
        let isReady = await window.electronAPI.realdebrid.isTorrentReady(magnetLink.id);
        if (!isReady) {
            await window.electronAPI.realdebrid.selectTorrent(magnetLink.id);
            await this.pollUntilReady(magnetLink.id);
        }
        const torrentInfo = await window.electronAPI.realdebrid.getTorrentInfo(magnetLink.id);
        const download = await window.electronAPI.realdebrid.unrestrictLink(torrentInfo.links[0]);
        if (download === null) {
            throw new Error('Failed to unrestrict the link.');
        }
        // Temporarily register an event listener to store any download updates so that we can match our download to the correct downloadID
        const { flush } = listenUntilDownloadReady();
        const downloadID = await window.electronAPI.ddl.download([
            {
                link: download.download,
                path: getDownloadPath() +
                    '/' +
                    sanitizePathSegment(result.name) +
                    '/' +
                    sanitizePathSegment(result.filename),
            },
        ]);
        const updatedState = flush();
        if (downloadID === null) {
            currentDownloads.update((downloads) => {
                const matchingDownload = downloads.find((d) => d.id === tempId);
                if (!matchingDownload)
                    return downloads;
                matchingDownload.status = 'error';
                matchingDownload.usedDebridService = 'realdebrid';
                matchingDownload.appID = appID;
                downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
                return downloads;
            });
            throw new Error('Download failed to start.');
        }
        const safePath = getDownloadPath() +
            '/' +
            sanitizePathSegment(result.name) +
            '/' +
            sanitizePathSegment(result.filename);
        this.updateDownloadRequested(downloadID, tempId, download.download, safePath, 'realdebrid', updatedState, result);
    }
    async handleTorrentDownload(result, appID, tempId) {
        if (result.downloadType !== 'torrent')
            return;
        if (!result.name) {
            throw new Error('Addon did not provide a name for the torrent.');
        }
        if (!result.downloadURL) {
            throw new Error('Addon did not provide a downloadURL for the torrent.');
        }
        // add torrent link
        const torrent = await window.electronAPI.realdebrid.addTorrent(result.downloadURL);
        let isReady = await window.electronAPI.realdebrid.isTorrentReady(torrent.id);
        if (!isReady) {
            await window.electronAPI.realdebrid.selectTorrent(torrent.id);
            await this.pollUntilReady(torrent.id);
        }
        const torrentInfo = await window.electronAPI.realdebrid.getTorrentInfo(torrent.id);
        // currently only supporting the first link
        const download = await window.electronAPI.realdebrid.unrestrictLink(torrentInfo.links[0]);
        if (download === null) {
            throw new Error('Failed to unrestrict the link.');
        }
        // Temporarily register an event listener to store any download updates so that we can match our download to the correct downloadID
        const { flush } = listenUntilDownloadReady();
        const safePath = getDownloadPath() +
            '/' +
            sanitizePathSegment(result.name) +
            '/' +
            sanitizePathSegment(result.filename);
        const downloadID = await window.electronAPI.ddl.download([
            {
                link: download.download,
                path: safePath,
                headers: {
                    'OGI-Parallel-Limit': '1',
                },
            },
        ]);
        const updatedState = flush();
        if (downloadID === null) {
            currentDownloads.update((downloads) => {
                const matchingDownload = downloads.find((d) => d.id === tempId);
                if (!matchingDownload)
                    return downloads;
                matchingDownload.status = 'error';
                matchingDownload.usedDebridService = 'realdebrid';
                matchingDownload.appID = appID;
                downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
                return downloads;
            });
            throw new Error('Download failed to start.');
        }
        this.updateDownloadRequested(downloadID, tempId, download.download, safePath, 'realdebrid', updatedState, result);
    }
}
//# sourceMappingURL=RealDebridService.js.map