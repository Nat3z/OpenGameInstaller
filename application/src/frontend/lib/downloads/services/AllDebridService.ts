import { DebridError, formatError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import {
  cardStatusFromHandshake,
  finalizeDownloadCard,
} from '@/frontend/lib/downloads/events';
import { updateDownloadStatus } from '@/frontend/lib/downloads/lifecycle';
import {
  dedupeFileNames,
  safeDownloadPath,
  sanitizePathSegment,
  urlBasename,
} from '@/frontend/lib/downloads/paths';
import { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import type { SearchResultWithAddon } from '@/frontend/lib/tasks/runner';
import { createNotification, currentDownloads } from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

type AllDebridSearchResult = SearchResultWithAddon & {
  downloadURL: string;
  name: string;
  filename?: string;
};

const allDebridRpc = <A, E>(
  operation: Effect.Effect<A, E>,
  message: string
): Effect.Effect<A, DebridError> =>
  operation.pipe(
    Effect.mapError(
      (cause) =>
        new DebridError({
          message: `${message}: ${formatError(cause)}`,
          service: 'alldebrid',
        })
    )
  );

function localNamesForLinks(
  links: string[],
  fileMeta: { name: string; size?: number }[] | undefined,
  addonFilename: string | undefined
): string[] {
  return dedupeFileNames(
    links.map((link, index) => {
      if (links.length === 1 && addonFilename?.trim()) {
        const sanitized = sanitizePathSegment(addonFilename);
        const metaName = fileMeta?.[0]?.name;
        const archiveExt = metaName?.match(/\.(rar|part\d*|r\d+)$/i)?.[0];
        return archiveExt && !sanitized.match(/\.(rar|part\d*|r\d+)$/i)
          ? sanitized + archiveExt
          : sanitized;
      }
      return fileMeta?.[index]?.name
        ? sanitizePathSegment(fileMeta[index].name)
        : urlBasename(link);
    })
  );
}

function waitForTorrentReady(id: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        yield* allDebridRpc(
          electronRpc.alldebrid.isTorrentReady(id),
          'Failed to check AllDebrid torrent status'
        )
      ) {
        return;
      }
      yield* Effect.sleep(3000);
    }
    return yield* Effect.fail(
      new DebridError({
        message: 'Torrent not ready in time.',
        service: 'alldebrid',
      })
    );
  });
}

/** Routes magnet and torrent downloads through AllDebrid. */
export class AllDebridService extends BaseService {
  readonly types = ['all-debrid-magnet', 'all-debrid-torrent'];

  startDownload(
    result: SearchResultWithAddon,
    appID: number,
    event: MouseEvent | null,
    htmlButton?: HTMLButtonElement
  ) {
    return Effect.gen(this, function* () {
      if (result.downloadType !== 'magnet' && result.downloadType !== 'torrent')
        return;
      const tempId = this.queueRequestDownload(result, appID, 'alldebrid');
      if (!result.downloadURL) {
        return yield* Effect.fail(
          new ValidationError({
            message: 'Addon did not provide a magnet link.',
            field: 'downloadURL',
          })
        );
      }
      const worked = yield* allDebridRpc(
        electronRpc.alldebrid.updateKey(),
        'Failed to update AllDebrid API key'
      );
      if (!worked) {
        return yield* Effect.fail(
          new DebridError({
            message: 'Please set your AllDebrid API key in the settings.',
            service: 'alldebrid',
          })
        );
      }

      const resolvedButton =
        htmlButton ??
        (event?.currentTarget instanceof HTMLButtonElement
          ? event.currentTarget
          : null);
      const debridResult = result as AllDebridSearchResult;
      const flow = this.handleAllDebridDownload(
        debridResult,
        appID,
        tempId,
        result.downloadType === 'magnet'
          ? this.getTorrentIdFromMagnet(debridResult)
          : this.getTorrentIdFromTorrent(debridResult, resolvedButton)
      );
      yield* flow.pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            logger.sync.error('Failed to start AllDebrid download:', error);
            currentDownloads.update((downloads) =>
              downloads.map((download) =>
                download.id === tempId
                  ? { ...download, status: 'error', error: error.message }
                  : download
              )
            );
            if (resolvedButton) {
              resolvedButton.textContent = 'Download';
              resolvedButton.disabled = false;
            }
          })
        )
      );
    });
  }

  private getTorrentIdFromMagnet(result: AllDebridSearchResult) {
    return Effect.gen(function* () {
      const magnet = yield* allDebridRpc(
        electronRpc.alldebrid.addMagnet(result.downloadURL),
        'Failed to add magnet to AllDebrid'
      );
      return magnet.id;
    });
  }

  private getTorrentIdFromTorrent(
    result: AllDebridSearchResult,
    htmlButton?: HTMLButtonElement | null
  ) {
    return Effect.gen(function* () {
      const resetButton = () => {
        if (htmlButton) {
          htmlButton.textContent = 'Download';
          htmlButton.disabled = false;
        }
      };
      if (!result.name || !result.downloadURL) {
        const message = !result.name
          ? 'Addon did not provide a name for the torrent.'
          : 'Addon did not provide a downloadURL for the torrent.';
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message,
        });
        resetButton();
        return yield* Effect.fail(
          new ValidationError({
            message,
            field: !result.name ? 'name' : 'downloadURL',
          })
        );
      }
      const torrent = yield* allDebridRpc(
        electronRpc.alldebrid.addTorrent(result.downloadURL),
        'Failed to add torrent to AllDebrid'
      );
      if (!torrent) {
        return yield* Effect.fail(
          new DebridError({
            message: 'Failed to add torrent to AllDebrid.',
            service: 'alldebrid',
          })
        );
      }
      return torrent.id;
    });
  }

  private handleAllDebridDownload(
    result: AllDebridSearchResult,
    appID: number,
    tempId: string,
    getTorrentId: Effect.Effect<string, DebridError | ValidationError>
  ) {
    return Effect.gen(function* () {
      const torrentId = yield* getTorrentId;
      const isReady = yield* allDebridRpc(
        electronRpc.alldebrid.isTorrentReady(torrentId),
        'Failed to check AllDebrid torrent status'
      );
      if (!isReady) {
        yield* allDebridRpc(
          electronRpc.alldebrid.selectTorrent(),
          'Failed to select AllDebrid torrent files'
        );
        yield* waitForTorrentReady(torrentId);
      }
      const torrentInfo = yield* allDebridRpc(
        electronRpc.alldebrid.getTorrentInfo(torrentId),
        'Failed to load AllDebrid torrent info'
      );
      const markError = () =>
        currentDownloads.update((downloads) =>
          downloads.map((download) =>
            download.id === tempId
              ? {
                  ...download,
                  status: 'error',
                  usedDebridService: 'alldebrid',
                  appID,
                }
              : download
          )
        );

      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'info',
        message: 'Unrestricting AllDebrid links...',
      });
      const resolvedLinks: string[] = [];
      for (const link of torrentInfo.links) {
        const download = yield* allDebridRpc(
          electronRpc.alldebrid.unrestrictLink(link),
          'Failed to unrestrict AllDebrid link'
        );
        if (!download) {
          return yield* Effect.fail(
            new DebridError({
              message:
                'Failed to unrestrict the link: No response from AllDebrid.',
              service: 'alldebrid',
            })
          );
        }
        resolvedLinks.push(download.download ?? download.link);
      }

      const safePath = safeDownloadPath(getDownloadPath(), result.name);
      const localNames = localNamesForLinks(
        resolvedLinks,
        torrentInfo.files,
        result.filename
      );
      const handshake = yield* allDebridRpc(
        electronRpc.ddl.download(
          resolvedLinks.map((link, index) => ({
            link,
            path: safePath + localNames[index],
            headers: { 'OGI-Parallel-Limit': '1' },
          }))
        ),
        'Failed to start AllDebrid download'
      );
      if (handshake.status === 'error' || !handshake.id) {
        markError();
        return yield* Effect.fail(
          new DebridError({
            message: 'Download failed to start.',
            service: 'alldebrid',
          })
        );
      }
      const files = resolvedLinks.map((link, index) => ({
        name: localNames[index],
        path: safePath + localNames[index],
        downloadURL: link,
        headers: { 'OGI-Parallel-Limit': '1' },
      }));
      updateDownloadStatus(tempId, {
        id: handshake.id,
        status: cardStatusFromHandshake(handshake),
        usedDebridService: 'alldebrid',
        appID,
        downloadPath:
          resolvedLinks.length === 1 ? safePath + localNames[0] : safePath,
        queuePosition: handshake.queuePosition,
        error: handshake.error,
        files,
      });
      yield* finalizeDownloadCard(handshake.id);
    });
  }
}
