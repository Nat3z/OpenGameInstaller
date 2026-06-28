import { currentDownloads } from '@/frontend/store';
import { getDownloadPath, updateDownloadStatus } from '@/frontend/utils';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import type { DownloadHandshakeResult } from '@/lib/download-handshake';
import { cardStatusFromHandshake } from '@/frontend/lib/downloads/events';

/**
 * Base class that all concrete download services should extend. It defines a
 * minimal contract so each service can be discovered and invoked in a generic
 * fashion.
 */
export abstract class BaseService {
  /**
   * List of downloadType strings handled by this service (e.g. ['torrent', 'magnet']).
   */
  abstract readonly types: string[];

  /**
   * Execute the download flow for the given result. Concrete implementations
   * should move the logic that currently lives in lifecycle.ts into this
   * method. When called recursively (e.g. from RequestService), htmlButton may
   * be passed so the button element is available even when event.currentTarget
   * is null.
   */
  abstract startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ): Promise<void>;

  queueRequestDownload(
    result: SearchResultWithAddon,
    appID: number,
    usedDebridService: string
  ) {
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
          usedDebridService: usedDebridService as any,
          downloadPath: getDownloadPath() + '/' + result.name,
          downloadSpeed: 0,
          ...result,
        },
      ];
    });

    return tempId;
  }

  updateDownloadRequested(
    handshake: DownloadHandshakeResult,
    tempid: string,
    downloadUrl: string,
    downloadPath: string,
    usedDebridService: string,
    result: SearchResultWithAddon
  ) {
    updateDownloadStatus(tempid, {
      id: handshake.id,
      status: cardStatusFromHandshake(handshake),
      usedDebridService: usedDebridService as any,
      downloadPath: downloadPath,
      queuePosition: handshake.queuePosition,
      error: handshake.error,
      downloadURL: downloadUrl,
      ...((result.downloadType === 'torrent' ||
        result.downloadType === 'magnet') && {
        originalDownloadURL: result.downloadURL,
      }),
    });
  }
}
