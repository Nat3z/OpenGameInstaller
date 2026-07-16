import type { OgiError } from '@ogi/errors';
import { Effect } from 'effect';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import { cardStatusFromHandshake } from '@/frontend/lib/downloads/events';
import { safeDownloadPath } from '@/frontend/lib/downloads/paths';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import {
  currentDownloads,
  type DownloadStatusAndInfo,
} from '@/frontend/store.svelte';
import { updateDownloadStatus } from '@/frontend/utils';
import type { DownloadHandshakeResult } from '@/lib/download-handshake';

/** Base contract implemented by each frontend download service. */
export abstract class BaseService {
  abstract readonly types: string[];

  abstract startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ): Effect.Effect<void, OgiError>;

  queueRequestDownload(
    result: SearchResultWithAddon,
    appID: number,
    usedDebridService: string
  ) {
    const tempId = Math.random().toString(36).substring(2, 15);
    currentDownloads.update((downloads) => [
      ...downloads,
      {
        id: tempId,
        downloadSize: 0,
        status: 'rd-downloading',
        appID,
        files: [],
        progress: 0,
        usedDebridService: usedDebridService as any,
        downloadPath: safeDownloadPath(getDownloadPath(), result.name),
        downloadSpeed: 0,
        ...result,
      },
    ]);
    return tempId;
  }

  updateDownloadRequested(
    handshake: DownloadHandshakeResult,
    tempid: string,
    downloadUrl: string,
    downloadPath: string,
    usedDebridService: string,
    result: SearchResultWithAddon,
    files?: DownloadStatusAndInfo['files']
  ) {
    updateDownloadStatus(tempid, {
      id: handshake.id,
      status: cardStatusFromHandshake(handshake),
      usedDebridService: usedDebridService as any,
      downloadPath,
      queuePosition: handshake.queuePosition,
      error: handshake.error,
      downloadURL: downloadUrl,
      ...(files && { files }),
      ...((result.downloadType === 'torrent' ||
        result.downloadType === 'magnet') && {
        originalDownloadURL: result.downloadURL,
      }),
    });
  }
}
