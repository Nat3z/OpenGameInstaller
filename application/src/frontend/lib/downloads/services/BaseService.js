import { currentDownloads } from '../../../store';
import { getDownloadPath, updateDownloadStatus } from '../../../utils';
/**
 * Base class that all concrete download services should extend. It defines a
 * minimal contract so each service can be discovered and invoked in a generic
 * fashion.
 */
export class BaseService {
    queueRequestDownload(result, appID, usedDebridService) {
        const tempId = Math.random().toString(36).substring(2, 15);
        currentDownloads.update((downloads) => {
            return [
                ...downloads,
                {
                    id: '' + tempId,
                    downloadSize: 0,
                    status: 'rd-downloading',
                    appID: appID,
                    files: [],
                    progress: 0,
                    // im lazy to type this every single time. so this will do.
                    usedDebridService: usedDebridService,
                    downloadPath: getDownloadPath() + '/' + result.name,
                    downloadSpeed: 0,
                    ...result,
                },
            ];
        });
        return tempId;
    }
    updateDownloadRequested(downloadId, tempid, downloadUrl, downloadPath, usedDebridService, flushed, result) {
        updateDownloadStatus(tempid, {
            id: downloadId,
            status: 'downloading',
            usedDebridService: usedDebridService,
            downloadPath: downloadPath,
            queuePosition: flushed[tempid]?.queuePosition,
            downloadURL: downloadUrl,
            ...((result.downloadType === 'torrent' ||
                result.downloadType === 'magnet') && {
                originalDownloadURL: result.downloadURL,
            }),
        });
    }
}
//# sourceMappingURL=BaseService.js.map