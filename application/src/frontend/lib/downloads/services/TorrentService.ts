import { DownloadError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
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
import { electronRpc } from '@/frontend/lib/electron-rpc';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { currentDownloads } from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

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

      const handshake = yield* (
        result.downloadType === 'torrent'
          ? electronRpc.torrent.downloadTorrent(
              result.downloadURL!,
              downloadPath
            )
          : electronRpc.torrent.downloadMagnet(
              result.downloadURL!,
              downloadPath
            )
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DownloadError({
              message: 'Failed to start torrent download.',
              cause,
            })
        )
      );

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
        logger.error('Torrent download error:', error)
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
