import { DownloadError, ValidationError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
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

/** Handles simple direct file downloads (single or multi-part). */
export class DirectService extends BaseService {
  readonly types = ['direct'];

  startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ) {
    const button = htmlButton ?? event?.currentTarget ?? null;
    return Effect.gen(function* () {
      if (result.downloadType !== 'direct') return;
      if (!(button instanceof HTMLButtonElement)) return;

      if (!result.files?.length) {
        return yield* Effect.fail(
          new ValidationError({
            message: 'Addon did not provide files for the direct download.',
            field: 'files',
          })
        );
      }

      const baseDir = getDownloadPath();
      const sanitizedName = sanitizePathSegment(result.name);
      const collectedFiles = yield* Effect.try({
        try: () =>
          result.files.map((file) => ({
            path: safeDownloadPath(
              baseDir,
              sanitizedName,
              sanitizePathSegment(file.name)
            ),
            link: file.downloadURL,
            headers: { ...(file.headers ?? {}) },
          })),
        catch: (cause) =>
          new DownloadError({
            message: 'Failed to prepare direct download files.',
            cause,
          }),
      });
      const persistedFiles = result.files.map((file, i) => ({
        name: sanitizePathSegment(file.name),
        path: collectedFiles[i].path,
        downloadURL: file.downloadURL,
        headers: collectedFiles[i].headers,
      }));

      button.textContent = 'Downloading...';
      button.disabled = true;

      const handshake = yield* electronRpc.ddl.download(collectedFiles).pipe(
        Effect.mapError(
          (cause) =>
            new DownloadError({
              message: 'Failed to start direct download.',
              cause,
            })
        )
      );
      currentDownloads.update((downloads) => [
        ...downloads,
        {
          id: handshake.id,
          status: cardStatusFromHandshake(handshake),
          downloadPath: safeDownloadPath(baseDir, sanitizedName),
          downloadSpeed: 0,
          progress: 0,
          appID,
          downloadSize: 0,
          queuePosition: handshake.queuePosition,
          error: handshake.error,
          ...result,
          files: persistedFiles,
        },
      ]);
      yield* finalizeDownloadCard(handshake.id);
    }).pipe(
      Effect.tapError((error) => logger.error('Direct download error:', error)),
      Effect.ensuring(
        Effect.sync(() => {
          if (button instanceof HTMLButtonElement) {
            button.textContent = 'Download';
            button.disabled = false;
          }
        })
      )
    );
  }
}
