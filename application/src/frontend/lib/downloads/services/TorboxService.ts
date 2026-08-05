import { DebridError, formatError } from '@ogi/errors';
import { Effect } from 'effect';
import { getConfigClientOption } from '@/frontend/lib/config/client';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import { finalizeDownloadCard } from '@/frontend/lib/downloads/events';
import { safeDownloadPath } from '@/frontend/lib/downloads/paths';
import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { currentDownloads } from '@/frontend/store.svelte';

const BASE_URL = 'https://api.torbox.app/v1';
type TorboxTorrent = {
  id: number;
  hash: string;
  download_finished: boolean;
};
type TorboxTorrentListResponse = {
  success: boolean;
  error: string | null;
  detail: string;
  data: TorboxTorrent[];
};

const torboxRpc = <A, E>(operation: Effect.Effect<A, E>, message: string) =>
  operation.pipe(
    Effect.mapError(
      (cause) =>
        new DebridError({
          message: `${message}: ${formatError(cause)}`,
          service: 'torbox' as const,
        })
    )
  );

export class TorboxService extends BaseService {
  readonly types = ['torbox-magnet', 'torbox-torrent'];

  startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ) {
    let originalText = '';
    let originalDisabled = false;
    return Effect.gen(this, function* () {
      if (event === null) return;
      if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
        return;
      if (htmlButton) {
        originalText = htmlButton.textContent || '';
        originalDisabled = htmlButton.disabled;
        htmlButton.textContent = 'Downloading...';
        htmlButton.disabled = true;
      }

      const options = getConfigClientOption<{ torboxApiKey?: string }>(
        'realdebrid'
      );
      if (!options?.torboxApiKey) {
        return yield* Effect.fail(
          new DebridError({
            message: 'Please set your TorBox API key in the settings.',
            service: 'torbox',
          })
        );
      }
      const { torboxApiKey } = options;
      const formData = new FormData();
      let torrentHash = '';
      if (result.downloadType === 'torrent') {
        const torrentData = yield* torboxRpc(
          electronRpc.downloadTorrentInto(result.downloadURL!),
          'Failed to load torrent data'
        );
        formData.append('file', new Blob([torrentData.buffer as ArrayBuffer]));
        torrentHash = yield* torboxRpc(
          electronRpc.getTorrentHash(torrentData),
          'Failed to hash torrent'
        );
      } else {
        formData.append('magnet', result.downloadURL!);
        torrentHash = yield* torboxRpc(
          electronRpc.getTorrentHash(result.downloadURL!),
          'Failed to hash magnet'
        );
      }
      formData.append('seed', '1');
      formData.append('allow_zip', 'true');
      formData.append('as_queued', 'false');

      const response = yield* torboxRpc(
        electronRpc.app.axios<{
          success: boolean;
          error: string | null;
          detail: string;
          data:
            | { hash: string; queued_id?: number; torrent_id?: number }
            | { cooldown_until: number };
        }>({
          url: `${BASE_URL}/api/torrents/createtorrent`,
          method: 'post',
          data: Object.fromEntries(formData.entries()),
          headers: {
            'Content-Type': 'multipart/form-data',
            Authorization: `Bearer ${torboxApiKey}`,
          },
        }),
        'Failed to create TorBox torrent'
      );
      if (response.status !== 200) {
        const detail = response.data.detail;
        const message =
          response.data.error === 'DOWNLOAD_TOO_LARGE'
            ? 'Your current plan does not support the requested download size.'
            : detail.includes('active torrent limit of')
              ? 'You have reached your active torrent limit.'
              : detail.includes('reached your monthly download limit')
                ? 'You have reached your monthly download limit.'
                : detail.includes('must provide')
                  ? 'Addon did not provide a valid file or magnet.'
                  : detail;
        return yield* Effect.fail(
          new DebridError({ message, service: 'torbox' })
        );
      }

      const responseData = response.data.data;
      if ('cooldown_until' in responseData) {
        return yield* Effect.fail(
          new DebridError({
            message: `You are on cooldown until ${new Date(
              responseData.cooldown_until * 1000
            ).toLocaleString()}.`,
            service: 'torbox',
          })
        );
      }
      const { queued_id, torrent_id } = responseData;
      if (!queued_id && !torrent_id) {
        return yield* Effect.fail(
          new DebridError({
            message: 'No queued id or torrent id found.',
            service: 'torbox',
          })
        );
      }

      if (queued_id) {
        const startResponse = yield* torboxRpc(
          electronRpc.app.axios({
            url: `${BASE_URL}/api/queued/controlqueued`,
            method: 'post',
            data: { queued_id, operation: 'start', all: false },
            headers: { Authorization: `Bearer ${torboxApiKey}` },
          }),
          'Failed to start queued TorBox torrent'
        );
        if (startResponse.status !== 200) {
          return yield* Effect.fail(
            new DebridError({
              message: 'Failed to start torrent.',
              service: 'torbox',
            })
          );
        }
      }

      const tempId = this.queueRequestDownload(result, appID, 'torbox');
      let finalTorrentId = torrent_id;
      if (!finalTorrentId) {
        for (let attempt = 0; attempt < 217; attempt++) {
          const list = yield* torboxRpc(
            electronRpc.app.axios<TorboxTorrentListResponse>({
              url: `${BASE_URL}/api/torrents/mylist?bypass_cache=true`,
              method: 'get',
              headers: { Authorization: `Bearer ${torboxApiKey}` },
            }),
            'Failed to poll TorBox torrent'
          );
          const torrent = list.data.success
            ? list.data.data.find((item) => item.hash === torrentHash)
            : undefined;
          if (torrent?.download_finished) {
            finalTorrentId = torrent.id;
            break;
          }
          yield* Effect.sleep(3000);
        }
      }
      if (!finalTorrentId) {
        return yield* Effect.fail(
          new DebridError({
            message: 'Timed out waiting for torrent to be ready.',
            service: 'torbox',
          })
        );
      }

      const url = new URL(`${BASE_URL}/api/torrents/requestdl`);
      url.searchParams.set('token', torboxApiKey);
      url.searchParams.set('torrent_id', finalTorrentId.toString());
      url.searchParams.set('zip_link', 'true');
      url.searchParams.set('redirect', 'true');
      const downloadUrl = url.toString();
      const zipFilename = `${result.filename}.zip`;
      const targetPath = safeDownloadPath(
        getDownloadPath(),
        result.name,
        zipFilename
      );
      const handshake = yield* torboxRpc(
        electronRpc.ddl.download([
          {
            link: downloadUrl,
            path: targetPath,
            headers: { 'OGI-Parallel-Limit': '1' },
          },
        ]),
        'Failed to start TorBox download'
      );
      if (handshake.status === 'error' || !handshake.id) {
        currentDownloads.update((downloads) =>
          downloads.filter((download) => download.id !== tempId)
        );
        return yield* Effect.fail(
          new DebridError({
            message: 'Failed to download the torrent.',
            service: 'torbox',
          })
        );
      }
      this.updateDownloadRequested(
        handshake,
        tempId,
        downloadUrl,
        targetPath,
        'torbox',
        result,
        [{ name: zipFilename, path: targetPath, downloadURL: downloadUrl }]
      );
      yield* finalizeDownloadCard(handshake.id);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (htmlButton) {
            htmlButton.textContent = originalText;
            htmlButton.disabled = originalDisabled;
          }
        })
      )
    );
  }
}
