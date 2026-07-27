import { DownloadError } from '@ogi/errors';
import type { SearchResult } from '@ogi-sdk/connect';
import { Effect } from 'effect';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import { addonServer } from '@/frontend/lib/core/ipc';
import { startDownloadEffect } from '@/frontend/lib/downloads/lifecycle';
import { safeDownloadPath } from '@/frontend/lib/downloads/paths';
import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { createNotification, currentDownloads } from '@/frontend/store.svelte';

/** Resolves the addon "request" response and delegates to its real service. */
export class RequestService extends BaseService {
  readonly types = ['request'];

  startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ) {
    return Effect.gen(function* () {
      const button = htmlButton ?? event?.currentTarget ?? null;
      const resolvedButton =
        button instanceof HTMLButtonElement ? button : undefined;
      const localID = Math.floor(Math.random() * 1000000);
      currentDownloads.update((downloads) => [
        ...downloads,
        {
          ...result,
          files: [],
          id: String(localID),
          status: 'requesting',
          downloadPath: safeDownloadPath(getDownloadPath(), result.name),
          downloadSpeed: 0,
          progress: 0,
          appID,
          downloadSize: 0,
        },
      ]);

      console.log('Requesting download', result);
      const serializedResult = yield* Effect.try({
        try: () => JSON.parse(JSON.stringify(result)),
        catch: (cause) =>
          new DownloadError({
            message: 'Failed to serialize addon download request.',
            cause,
          }),
      });
      const response = yield* Effect.tryPromise({
        try: () =>
          addonServer
            .addon(result.addonSource, {
              onFailed: (error: string) => {
                createNotification({
                  id: Math.random().toString(36).substring(7),
                  type: 'error',
                  message: error,
                });
                currentDownloads.update((downloads) =>
                  downloads.map((download) =>
                    download.id === String(localID)
                      ? { ...download, status: 'error', error }
                      : download
                  )
                );
              },
            })
            .requestDl(appID, serializedResult) as Promise<SearchResult>,
        catch: (cause) =>
          new DownloadError({
            message: 'Failed to request download from addon.',
            cause,
          }),
      });

      if (response == null) {
        currentDownloads.update((downloads) =>
          downloads.map((download) =>
            download.id === String(localID)
              ? {
                  ...download,
                  status: 'error',
                  error: 'Failed to get download response',
                }
              : download
          )
        );
        if (resolvedButton) {
          resolvedButton.textContent = 'Download';
          resolvedButton.disabled = false;
        }
        return;
      }

      const updatedResult = {
        ...response,
        addonSource: result.addonSource,
        addonName: result.addonName,
        capsuleImage: result.capsuleImage,
        coverImage: result.coverImage,
        storefront: result.storefront,
        name: result.name,
        isUpdate: result.isUpdate,
        updateVersion: result.updateVersion,
        clearOldFilesBeforeUpdate: result.clearOldFilesBeforeUpdate,
      } as unknown as SearchResultWithAddon;
      currentDownloads.update((downloads) =>
        downloads.filter((download) => download.id !== String(localID))
      );
      if (resolvedButton) {
        resolvedButton.textContent = 'Downloading...';
        resolvedButton.disabled = true;
      }
      yield* startDownloadEffect(updatedResult, appID, event, resolvedButton);
    });
  }
}
