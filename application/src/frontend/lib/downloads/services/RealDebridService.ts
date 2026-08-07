import { DebridError, formatError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import { finalizeDownloadCard } from '@/frontend/lib/downloads/events';
import { safeDownloadPath } from '@/frontend/lib/downloads/paths';
import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { currentDownloads } from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

type RealDebridSearchResult = SearchResultWithAddon & {
  downloadType: 'magnet' | 'torrent';
  filename: string;
  downloadURL: string;
};

const realDebridRpc = <A, E>(
  operation: Effect.Effect<A, E>,
  message: string
): Effect.Effect<A, DebridError> =>
  operation.pipe(
    Effect.mapError(
      (cause) =>
        new DebridError({
          message: `${message}: ${formatError(cause)}`,
          service: 'realdebrid',
        })
    )
  );

function waitForTorrentReady(id: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        yield* realDebridRpc(
          electronRpc.realdebrid.isTorrentReady(id),
          'Failed to check Real-Debrid torrent status'
        )
      ) {
        return;
      }
      yield* Effect.sleep(3000);
    }
    return yield* Effect.fail(
      new DebridError({
        message: 'Timed out waiting for Real-Debrid torrent to be ready.',
        service: 'realdebrid',
      })
    );
  });
}

/** Routes magnet and torrent downloads through Real-Debrid. */
export class RealDebridService extends BaseService {
  readonly types = ['real-debrid-magnet', 'real-debrid-torrent'];

  startDownload(
    result: SearchResultWithAddon,
    appID: number,
    _event: MouseEvent | null,
    _htmlButton?: HTMLButtonElement
  ) {
    let tempId: string | undefined;
    return Effect.gen(this, function* () {
      if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
        return;
      if (!result.downloadURL) {
        return yield* Effect.fail(
          new ValidationError({
            message: 'Addon did not provide a magnet link.',
            field: 'downloadURL',
          })
        );
      }

      const worked = yield* realDebridRpc(
        electronRpc.realdebrid.updateKey(),
        'Failed to update Real-Debrid API key'
      );
      if (!worked) {
        return yield* Effect.fail(
          new DebridError({
            message: 'Please set your Real-Debrid API key in the settings.',
            service: 'realdebrid',
          })
        );
      }

      const hosts = yield* realDebridRpc(
        electronRpc.realdebrid.getHosts(),
        'Failed to load Real-Debrid hosts'
      );
      const debridResult = result as RealDebridSearchResult;
      tempId = this.queueRequestDownload(debridResult, appID, 'realdebrid');
      if (debridResult.downloadType === 'magnet') {
        yield* this.handleMagnetDownload(
          debridResult,
          appID,
          tempId,
          hosts[0]?.host
        );
      } else {
        yield* this.handleTorrentDownload(
          debridResult,
          appID,
          tempId,
          hosts[0]?.host
        );
      }
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          logger.sync.error('Failed to start Real-Debrid download:', error);
          if (!tempId) return;
          currentDownloads.update((downloads) =>
            downloads.map((download) =>
              download.id === tempId
                ? { ...download, status: 'error', error: error.message }
                : download
            )
          );
        })
      )
    );
  }

  private handleMagnetDownload(
    result: RealDebridSearchResult,
    appID: number,
    tempId: string,
    host?: string
  ) {
    return Effect.gen(this, function* () {
      if (result.downloadType !== 'magnet') return;
      const magnet = yield* realDebridRpc(
        electronRpc.realdebrid.addMagnet(result.downloadURL!, host),
        'Failed to add magnet to Real-Debrid'
      );
      yield* this.finishDebridDownload(result, appID, tempId, magnet.id);
    });
  }

  private handleTorrentDownload(
    result: RealDebridSearchResult,
    appID: number,
    tempId: string,
    host?: string
  ) {
    return Effect.gen(this, function* () {
      if (result.downloadType !== 'torrent') return;
      if (!result.name || !result.downloadURL) {
        return yield* Effect.fail(
          new ValidationError({
            message: !result.name
              ? 'Addon did not provide a name for the torrent.'
              : 'Addon did not provide a downloadURL for the torrent.',
            field: !result.name ? 'name' : 'downloadURL',
          })
        );
      }
      const torrent = yield* realDebridRpc(
        electronRpc.realdebrid.addTorrent(result.downloadURL!, host),
        'Failed to add torrent to Real-Debrid'
      );
      yield* this.finishDebridDownload(result, appID, tempId, torrent.id);
    });
  }

  private finishDebridDownload(
    result: RealDebridSearchResult,
    appID: number,
    tempId: string,
    torrentId: string
  ) {
    return Effect.gen(this, function* () {
      const isReady = yield* realDebridRpc(
        electronRpc.realdebrid.isTorrentReady(torrentId),
        'Failed to check Real-Debrid torrent status'
      );
      if (!isReady) {
        yield* realDebridRpc(
          electronRpc.realdebrid.selectTorrent(torrentId),
          'Failed to select Real-Debrid torrent files'
        );
        yield* waitForTorrentReady(torrentId);
      }

      const torrentInfo = yield* realDebridRpc(
        electronRpc.realdebrid.getTorrentInfo(torrentId),
        'Failed to load Real-Debrid torrent info'
      );
      const download = yield* realDebridRpc(
        electronRpc.realdebrid.unrestrictLink(torrentInfo.links[0]),
        'Failed to unrestrict Real-Debrid link'
      );
      if (download === null) {
        return yield* Effect.fail(
          new DebridError({
            message: 'Failed to unrestrict the link.',
            service: 'realdebrid',
          })
        );
      }

      const targetPath = safeDownloadPath(
        getDownloadPath(),
        result.name,
        result.filename
      );
      const persistedFiles = [
        {
          name: result.filename ?? 'download',
          path: targetPath,
          downloadURL: download.download,
        },
      ];
      const handshake = yield* realDebridRpc(
        electronRpc.ddl.download([
          {
            link: download.download,
            path: targetPath,
            headers: { 'OGI-Parallel-Limit': '1' },
          },
        ]),
        'Failed to start Real-Debrid download'
      );
      if (handshake.status === 'error' || !handshake.id) {
        currentDownloads.update((downloads) =>
          downloads.map((item) =>
            item.id === tempId
              ? {
                  ...item,
                  status: 'error',
                  usedDebridService: 'realdebrid',
                  appID,
                }
              : item
          )
        );
        return yield* Effect.fail(
          new DebridError({
            message: 'Download failed to start.',
            service: 'realdebrid',
          })
        );
      }
      this.updateDownloadRequested(
        handshake,
        tempId,
        download.download,
        targetPath,
        'realdebrid',
        result,
        persistedFiles
      );
      yield* finalizeDownloadCard(handshake.id);
    });
  }
}
