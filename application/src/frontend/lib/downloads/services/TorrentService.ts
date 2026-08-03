import { DownloadError, ValidationError } from '@ogi/errors';
import { Effect } from 'effect';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import {
  cardStatusFromHandshake,
  finalizeDownloadCard,
} from '@/frontend/lib/downloads/events';
import {
  safeDownloadPath,
  sanitizePathSegment,
} from '@/frontend/lib/downloads/paths';
import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { currentDownloads } from '@/frontend/store.svelte';

/** Handles standard magnet and torrent downloads. */
export class TorrentService extends BaseService {
  readonly types = ['torrent', 'magnet'];

  startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ) {
    const button =
      htmlButton ?? (event?.currentTarget as HTMLButtonElement | null);
    const resolvedButton = button instanceof HTMLButtonElement ? button : null;

    return Effect.gen(function* () {
      if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
        return;
      if (!result.downloadURL) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Addon did not provide a ${result.downloadType} file.`,
            field: 'downloadURL',
          })
        );
      }

      const baseDir = getDownloadPath();
      const downloadPath = safeDownloadPath(baseDir, result.name);
      const persistedFiles = result.filename
        ? [
            {
              name: sanitizePathSegment(result.filename),
              path: safeDownloadPath(baseDir, result.name, result.filename),
              downloadURL: result.downloadURL,
            },
          ]
        : [];

      if (resolvedButton) {
        resolvedButton.textContent = 'Downloading...';
        resolvedButton.disabled = true;
      }

      const handshake = yield* Effect.tryPromise({
        try: () =>
          result.downloadType === 'torrent'
            ? window.electronAPI.torrent.downloadTorrent(
                result.downloadURL!,
                downloadPath
              )
            : window.electronAPI.torrent.downloadMagnet(
                result.downloadURL!,
                downloadPath
              ),
        catch: (cause) =>
          new DownloadError({
            message: 'Failed to start torrent download.',
            cause,
          }),
      });

      currentDownloads.update((downloads) => [
        ...downloads,
        {
          ...result,
          id: handshake.id,
          status: cardStatusFromHandshake(handshake),
          downloadPath,
          downloadSpeed: 0,
          files: persistedFiles,
          progress: 0,
          queuePosition: handshake.queuePosition,
          error: handshake.error,
          appID,
          downloadSize: 0,
          originalDownloadURL: result.downloadURL,
        },
      ]);
      yield* finalizeDownloadCard(handshake.id);
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => console.error('Torrent download error:', error))
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (resolvedButton) {
            resolvedButton.textContent = 'Download';
            resolvedButton.disabled = false;
          }
        })
      )
    );
  }
}
