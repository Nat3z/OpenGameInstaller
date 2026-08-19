import { DownloadError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { get } from 'svelte/store';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import { getApp } from '@/frontend/lib/core/library';
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
import { currentDownloads, gamesLaunched } from '@/frontend/store.svelte';

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

      const currentApp = result.isUpdate ? getApp(appID) : undefined;
      if (result.isUpdate && currentApp && get(gamesLaunched)[appID]) {
        return yield* Effect.fail(
          new DownloadError({
            message: `Close ${result.name} before updating it.`,
          })
        );
      }
      if (result.isUpdate && currentApp) {
        const optimized = yield* electronRpc.update
          .prepareDirect({
            appID,
            installationPath: currentApp.cwd,
            sources: persistedFiles.map((file) => ({
              url: file.downloadURL,
              localPath: file.path,
              ...(file.headers ? { headers: file.headers } : {}),
            })),
          })
          .pipe(
            Effect.catchAll(() => Effect.succeed({ kind: 'fallback' as const }))
          );
        if (optimized.kind === 'optimized') {
          const id = crypto.randomUUID();
          currentDownloads.update((downloads) => [
            ...downloads,
            {
              id,
              status: 'downloading',
              downloadPath: safeDownloadPath(baseDir, sanitizedName),
              downloadSpeed: 0,
              progress: 1,
              appID,
              downloadSize: 0,
              ...result,
              files: persistedFiles,
              managedUpdate: {
                extractedPath: optimized.extractedPath,
                manifest: optimized.manifest,
              },
            },
          ]);
          document.dispatchEvent(
            new CustomEvent('ddl:download-complete', { detail: { id } })
          );
          return;
        }
      }

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
