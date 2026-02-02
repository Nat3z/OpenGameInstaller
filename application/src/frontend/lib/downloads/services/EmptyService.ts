import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import { currentDownloads, type DownloadStatusAndInfo } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { runSetupApp, runSetupAppUpdate } from '../../setup/setup';
import { updateDownloadStatus } from '../lifecycle';
import { getInitialDownloadSize } from '../initialDownloadSize';

/**
 * Handles "empty" downloads that skip directly to the setup phase.
 * This service immediately marks the download as completed, bypassing
 * any actual downloading, and proceeds straight to setup.
 */
export class EmptyService extends BaseService {
  readonly types = ['empty'];

  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent
  ): Promise<void> {
    if (event === null) return;
    if (event.target === null) return;
    const htmlButton = event.target as HTMLButtonElement;

    // Generate a unique ID for this download
    const downloadId = Math.random().toString(36).substring(2, 15);

    // Add download to store with 'completed' status to trigger setup immediately
    const downloadedItem: DownloadStatusAndInfo = {
      ...result,
      id: downloadId,
      status: 'completed',
      downloadPath: getDownloadPath() + '/' + result.name + '/',
      downloadSpeed: 0,
      progress: 100,
      appID,
      downloadSize: getInitialDownloadSize(result),
      files: (result as any).files || [],
    };
    // insert to store
    currentDownloads.update((downloads) => {
      return [...downloads, downloadedItem];
    });
    updateDownloadStatus(downloadId, downloadedItem);

    // Check if this is an update download and route to appropriate setup function
    if (downloadedItem.isUpdate) {
      await runSetupAppUpdate(
        downloadedItem,
        getDownloadPath() + '/' + result.name + '/',
        false,
        {}
      );
    } else {
      await runSetupApp(
        downloadedItem,
        getDownloadPath() + '/' + result.name + '/',
        false,
        {}
      );
    }

    htmlButton.textContent = 'Setting up...';
    htmlButton.disabled = true;
  }
}
