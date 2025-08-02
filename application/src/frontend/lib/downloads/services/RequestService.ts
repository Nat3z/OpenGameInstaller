import { BaseService } from './BaseService';
import type { SearchResultWithAddon } from '../../tasks/runner';
import type { SearchResult } from 'ogi-addon';
import { createNotification, currentDownloads } from '../../../store';
import { getDownloadPath } from '../../core/fs';
import { safeFetch } from '../../core/ipc';
import { startDownload } from '../lifecycle';

/**
 * Handles the initial "request" downloadType where we first need to ask the
 * addon backend for a direct/magnet/torrent URL.
 */
export class RequestService extends BaseService {
  readonly types = ['request'];

  async startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent
  ): Promise<void> {
    if (event === null) return;
    if (event.target === null) return;
    const htmlButton = event.target as HTMLButtonElement;

    // Create a local ID for tracking, similar to real-debrid cases
    const localID = Math.floor(Math.random() * 1000000);
    currentDownloads.update((downloads) => {
      return [
        ...downloads,
        {
          ...result,
          // changed to avoid special characters in the path and make it work with windows on wine
          id: '' + localID,
          status: 'requesting',
          downloadPath: getDownloadPath() + '/' + result.name,
          downloadSpeed: 0,
          progress: 0,
          appID,
          downloadSize: 0,
        },
      ];
    });

    console.log('Requesting download', result);
    const response: SearchResult = await safeFetch(
      'requestDownload',
      {
        addonID: result.addonSource,
        appID: appID,
        info: JSON.parse(JSON.stringify(result)),
      },
      {
        consume: 'json',
        onFailed: (error: string) => {
          createNotification({
            id: Math.random().toString(36).substring(7),
            type: 'error',
            message: error,
          });
          currentDownloads.update((downloads) => {
            const matchingDownload = downloads.find(
              (d) => d.id === localID + ''
            )!!;
            matchingDownload.status = 'error';
            matchingDownload.error = error;
            downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
            return downloads;
          });
        },
      }
    );

    console.log('Request response:', response);

    // Merge response with original context
    const updatedResult = {
      ...response,
      addonSource: result.addonSource,
      capsuleImage: result.capsuleImage,
      coverImage: result.coverImage,
      storefront: result.storefront,
    };

    // Remove the temporary requesting download
    currentDownloads.update((downloads) => {
      return downloads.filter((d) => d.id !== localID + '');
    });

    // Reset button state before recursive call
    htmlButton.textContent = 'Downloading...';
    htmlButton.disabled = true;

    // Recursively call startDownload with the resolved result
    // We need to import the startDownload function to call it recursively
    return await startDownload(updatedResult, appID, event);
  }
}
