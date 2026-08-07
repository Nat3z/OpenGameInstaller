import { DebridError, formatError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { getConfigClientOption } from '@/frontend/lib/config/client';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import { finalizeDownloadCard } from '@/frontend/lib/downloads/events';
import { safeDownloadPath } from '@/frontend/lib/downloads/paths';
import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { currentDownloads } from '@/frontend/store.svelte';

const BASE_URL = 'https://www.premiumize.me/api';
type PremiumizeErrorResponse = { status: 'error'; message: string };
type ResponseFolder =
  | PremiumizeErrorResponse
  | { status: 'success'; id: string; message?: string };
type PremiumizeFolderResponse =
  | PremiumizeErrorResponse
  | {
      status: 'success';
      content: Array<{ id: string; name: string }>;
      name: string;
      parent_id: string;
      breadcrumbs: string;
      folder_id?: string;
    };
type PremiumizeTransferResponse =
  | PremiumizeErrorResponse
  | { status: 'success'; id: string; name: string; type: string };
type PremiumizeTransfersListResponse =
  | PremiumizeErrorResponse
  | {
      status: 'success';
      transfers: Array<{
        id: string;
        status: 'finished' | 'waiting';
        folder_id: string;
      }>;
    };
type PremiumizeZipGenerateResponse =
  | PremiumizeErrorResponse
  | { status: 'success'; location: string };

const premiumizeRpc = <A, E>(operation: Effect.Effect<A, E>, message: string) =>
  operation.pipe(
    Effect.mapError(
      (cause) =>
        new DebridError({
          message: `${message}: ${formatError(cause)}`,
          service: 'premiumize' as const,
        })
    )
  );

export class PremiumizeService extends BaseService {
  readonly types = ['premiumize-magnet', 'premiumize-torrent'];

  startDownload(
    result: SearchResultWithAddon,
    appID: number,
    _event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ) {
    let originalText = '';
    let originalDisabled = false;
    let tempId: string | undefined;

    return Effect.gen(this, function* () {
      if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
        return;
      if (htmlButton) {
        originalText = htmlButton.textContent || '';
        originalDisabled = htmlButton.disabled;
        htmlButton.textContent = 'Downloading...';
        htmlButton.disabled = true;
      }

      tempId = this.queueRequestDownload(result, appID, 'premiumize');
      const options = getConfigClientOption<{ premiumizeApiKey?: string }>(
        'realdebrid'
      );
      if (!options?.premiumizeApiKey) {
        return yield* Effect.fail(
          new DebridError({
            message: 'Please set your Premiumize API key in the settings.',
            service: 'premiumize',
          })
        );
      }
      const { premiumizeApiKey } = options;

      const responseFolder = yield* premiumizeRpc(
        electronRpc.app.axios({
          method: 'POST',
          url: `${BASE_URL}/folder/create?apikey=${premiumizeApiKey}`,
          data: { name: 'OpenGameInstaller' },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        }),
        'Failed to create Premiumize folder'
      );
      const folderData = responseFolder.data as ResponseFolder;
      let folderId = folderData.status === 'success' ? folderData.id : '';
      if (folderData.status === 'error') {
        const searchResponse = yield* premiumizeRpc(
          electronRpc.app.axios({
            method: 'GET',
            url: `${BASE_URL}/folder/search?apikey=${premiumizeApiKey}&q=OpenGameInstaller`,
            headers: { Accept: 'application/json' },
          }),
          'Failed to search Premiumize folders'
        );
        const searchData = searchResponse.data as PremiumizeFolderResponse;
        if (searchData.status === 'error') {
          return yield* Effect.fail(
            new DebridError({
              message: searchData.message,
              service: 'premiumize',
            })
          );
        }
        folderId =
          searchData.content.find((item) => item.name === 'OpenGameInstaller')
            ?.id ?? '';
        if (!folderId) {
          return yield* Effect.fail(
            new DebridError({
              message: 'OpenGameInstaller folder not found in Premiumize.',
              service: 'premiumize',
            })
          );
        }
      }

      const formData = new FormData();
      if (result.downloadType === 'torrent') {
        const torrentData = yield* premiumizeRpc(
          electronRpc.downloadTorrentInto(result.downloadURL!),
          'Failed to download torrent data'
        );
        formData.append('file', new Blob([torrentData.buffer as ArrayBuffer]));
      } else {
        formData.append('src', result.downloadURL!);
      }
      formData.append('folder_id', folderId);
      const transferResponse = yield* premiumizeRpc(
        electronRpc.app.axios<PremiumizeTransferResponse>({
          method: 'POST',
          url: `${BASE_URL}/transfer/create?apikey=${premiumizeApiKey}`,
          data: Object.fromEntries(formData.entries()),
          headers: {
            'Content-Type': 'multipart/form-data',
            Accept: 'application/json',
          },
        }),
        'Failed to create Premiumize transfer'
      );
      if (transferResponse.data.status === 'error') {
        return yield* Effect.fail(
          new DebridError({
            message: transferResponse.data.message,
            service: 'premiumize',
          })
        );
      }
      const transferId = transferResponse.data.id;

      let foundFolderId = '';
      for (let attempt = 0; attempt <= 120; attempt++) {
        const transfersResponse = yield* premiumizeRpc(
          electronRpc.app.axios<PremiumizeTransfersListResponse>({
            method: 'GET',
            url: `${BASE_URL}/transfer/list?apikey=${premiumizeApiKey}`,
          }),
          'Failed to check Premiumize transfer'
        );
        if (
          transfersResponse.status === 200 &&
          transfersResponse.data.status === 'success'
        ) {
          const transfer = transfersResponse.data.transfers.find(
            (item) => item.id === transferId
          );
          if (transfer?.status === 'finished') {
            foundFolderId = transfer.folder_id || '';
            break;
          }
        }
        yield* Effect.sleep(2500);
      }
      if (!foundFolderId) {
        return yield* Effect.fail(
          new DebridError({
            message: 'Timed out waiting for Premiumize transfer.',
            service: 'premiumize',
          })
        );
      }

      const zipResponse = yield* premiumizeRpc(
        electronRpc.app.axios<PremiumizeZipGenerateResponse>({
          method: 'POST',
          url: `${BASE_URL}/zip/generate?apikey=${premiumizeApiKey}`,
          data: { 'folders[]': foundFolderId },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        }),
        'Failed to generate Premiumize download'
      );
      if (zipResponse.status !== 200 || zipResponse.data.status === 'error') {
        return yield* Effect.fail(
          new DebridError({
            message:
              zipResponse.data.status === 'error'
                ? zipResponse.data.message
                : 'Failed to get direct download from Premiumize.',
            service: 'premiumize',
          })
        );
      }

      const directDownloadUrl = zipResponse.data.location;
      const zipFilename = `${result.filename}.zip`;
      const targetPath = safeDownloadPath(
        getDownloadPath(),
        result.name,
        zipFilename
      );
      const handshake = yield* premiumizeRpc(
        electronRpc.ddl.download([
          {
            link: directDownloadUrl,
            path: targetPath,
            headers: { 'OGI-Parallel-Limit': '1' },
          },
        ]),
        'Failed to start Premiumize download'
      );
      if (handshake.status === 'error' || !handshake.id) {
        return yield* Effect.fail(
          new DebridError({
            message: 'Failed to download the torrent.',
            service: 'premiumize',
          })
        );
      }
      this.updateDownloadRequested(
        handshake,
        tempId,
        directDownloadUrl,
        targetPath,
        'premiumize',
        result,
        [
          {
            name: zipFilename,
            path: targetPath,
            downloadURL: directDownloadUrl,
          },
        ]
      );
      yield* finalizeDownloadCard(handshake.id);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (tempId) {
            currentDownloads.update((downloads) =>
              downloads.filter((download) => download.id !== tempId)
            );
          }
          if (htmlButton) {
            htmlButton.textContent = originalText;
            htmlButton.disabled = originalDisabled;
          }
        })
      )
    );
  }
}
