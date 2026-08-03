import { Effect } from 'effect';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import { updateDownloadStatus } from '@/frontend/lib/downloads/lifecycle';
import { safeDownloadPath } from '@/frontend/lib/downloads/paths';
import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import { runSetupApp, runSetupAppUpdate } from '@/frontend/lib/setup/setup';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import {
  currentDownloads,
  type DownloadStatusAndInfo,
} from '@/frontend/store.svelte';

/** Handles downloads that skip directly to setup. */
export class EmptyService extends BaseService {
  readonly types = ['empty'];

  startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ) {
    const resolvedButton = htmlButton ?? event?.currentTarget ?? null;
    return Effect.gen(function* () {
      if (resolvedButton instanceof HTMLButtonElement) {
        resolvedButton.textContent = 'Setting up...';
        resolvedButton.disabled = true;
      }

      const downloadId = Math.random().toString(36).substring(2, 15);
      const downloadFolder = safeDownloadPath(getDownloadPath(), result.name);
      const downloadedItem: DownloadStatusAndInfo = {
        ...result,
        id: downloadId,
        status: 'completed',
        downloadPath: downloadFolder,
        downloadSpeed: 0,
        progress: 100,
        appID,
        downloadSize: 0,
        files: (result as unknown as { files?: any[] }).files || [],
      };
      currentDownloads.update((downloads) => [...downloads, downloadedItem]);
      updateDownloadStatus(downloadId, downloadedItem);

      yield* downloadedItem.isUpdate
        ? runSetupAppUpdate(downloadedItem, downloadFolder, false, {})
        : runSetupApp(downloadedItem, downloadFolder, false, {});
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (resolvedButton instanceof HTMLButtonElement) {
            resolvedButton.textContent = 'Download';
            resolvedButton.disabled = false;
          }
        })
      )
    );
  }
}
