import { BaseService } from './BaseService';
import { currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { runSetupApp, runSetupAppUpdate } from '../../setup/setup';
import { updateDownloadStatus } from '../lifecycle';
import { sanitizePathSegment } from '../pathUtils';
/**
 * Handles "empty" downloads that skip directly to the setup phase.
 * This service immediately marks the download as completed, bypassing
 * any actual downloading, and proceeds straight to setup.
 */
export class EmptyService extends BaseService {
    types = ['empty'];
    async startDownload(result, appID, event, htmlButton) {
        const resolvedButton = htmlButton ?? event?.currentTarget ?? null;
        // UI-specific actions: set button to "Setting up..." BEFORE running async setup
        if (resolvedButton instanceof HTMLButtonElement) {
            resolvedButton.textContent = 'Setting up...';
            resolvedButton.disabled = true;
        }
        // Generate a unique ID for this download
        const downloadId = Math.random().toString(36).substring(2, 15);
        const basePath = getDownloadPath() + '/' + sanitizePathSegment(result.name) + '/';
        const downloadedItem = {
            ...result,
            id: downloadId,
            status: 'completed',
            downloadPath: basePath,
            downloadSpeed: 0,
            progress: 100,
            appID,
            downloadSize: 0,
            files: [],
        };
        // insert to store
        currentDownloads.update((downloads) => {
            return [...downloads, downloadedItem];
        });
        updateDownloadStatus(downloadId, downloadedItem);
        try {
            // Check if this is an update download and route to appropriate setup function
            if (downloadedItem.isUpdate) {
                await runSetupAppUpdate(downloadedItem, basePath, false, {});
            }
            else {
                await runSetupApp(downloadedItem, basePath, false, {});
            }
        }
        finally {
            if (resolvedButton instanceof HTMLButtonElement) {
                resolvedButton.textContent = 'Download';
                resolvedButton.disabled = false;
            }
        }
    }
}
//# sourceMappingURL=EmptyService.js.map