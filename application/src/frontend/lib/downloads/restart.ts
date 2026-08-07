import { DownloadError, formatError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { Effect } from 'effect';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import {
  getDownloadItem,
  updateDownloadStatus,
} from '@/frontend/lib/downloads/lifecycle';
import { safeDownloadPath } from '@/frontend/lib/downloads/paths';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import {
  createNotification,
  type DownloadStatusAndInfo,
} from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

export interface PausedDownloadState {
  id: string;
  downloadInfo: DownloadStatusAndInfo;
  pausedAt: number;
  originalDownloadURL?: string;
  files?: unknown[];
}

const downloadRpc = <A, E>(
  operation: Effect.Effect<A, E>,
  download: DownloadStatusAndInfo,
  message: string
) =>
  operation.pipe(
    Effect.mapError(
      (cause) =>
        new DownloadError({
          message: `${message}: ${formatError(cause)}`,
          downloadId: download.id,
          cause,
        })
    )
  );

function effectiveDownloadUrl(
  download: DownloadStatusAndInfo
): string | undefined {
  const downloadURL =
    download.downloadType === 'torrent' || download.downloadType === 'magnet'
      ? download.downloadURL
      : undefined;
  return download.usedDebridService
    ? downloadURL || download.originalDownloadURL
    : download.originalDownloadURL || downloadURL;
}

function restartDirectDownload(download: DownloadStatusAndInfo) {
  return Effect.gen(function* () {
    const effectiveUrl = effectiveDownloadUrl(download);
    const downloadFiles = download.files?.length ? download.files : undefined;
    let files: Array<{
      link: string;
      path: string;
      headers?: Record<string, string>;
    }>;

    if (downloadFiles) {
      const baseDir = getDownloadPath();
      files = downloadFiles.map((file) => ({
        link: file.downloadURL,
        path: file.path ?? safeDownloadPath(baseDir, download.name, file.name),
        headers: file.headers,
      }));
    } else if (effectiveUrl) {
      const urlFilename = yield* Effect.sync(() => {
        try {
          const url = new URL(effectiveUrl);
          const last = url.pathname.split('/').pop();
          return last ? decodeURIComponent(last) : undefined;
        } catch {
          return undefined;
        }
      });
      const isFilePath =
        typeof download.downloadPath === 'string' &&
        !download.downloadPath.endsWith('/') &&
        !download.downloadPath.endsWith('\\');
      const filename =
        (urlFilename && /\.[A-Za-z0-9]{1,8}$/.test(urlFilename)
          ? urlFilename
          : 'filename' in download
            ? download.filename
            : undefined) ?? 'download';
      files = [
        {
          link: effectiveUrl,
          path: isFilePath
            ? download.downloadPath
            : safeDownloadPath(getDownloadPath(), download.name, filename),
        },
      ];
    } else {
      return yield* Effect.fail(
        new DownloadError({
          message: 'No download URL available for restart',
          downloadId: download.id,
        })
      );
    }

    const handshake = yield* downloadRpc(
      electronRpc.ddl.download(files, download.part),
      download,
      'Failed to restart direct download'
    );
    return handshake.id;
  });
}

function restartTorrentDownload(download: DownloadStatusAndInfo) {
  return Effect.gen(function* () {
    const effectiveUrl = effectiveDownloadUrl(download);
    if (!effectiveUrl) {
      return yield* Effect.fail(
        new DownloadError({
          message: 'No torrent URL available for restart',
          downloadId: download.id,
        })
      );
    }
    if (
      download.downloadType !== 'torrent' &&
      download.downloadType !== 'magnet'
    ) {
      return yield* Effect.fail(
        new DownloadError({
          message: `Unsupported torrent download type: ${download.downloadType}`,
          downloadId: download.id,
        })
      );
    }

    const persistedFilePath = download.files?.[0]?.path;
    const folderPath =
      download.downloadPath.endsWith('/') ||
      download.downloadPath.endsWith('\\')
        ? download.downloadPath
        : persistedFilePath
          ? persistedFilePath.replace(/[/\\][^/\\]+$/, '/')
          : safeDownloadPath(getDownloadPath(), download.name);
    const path = folderPath;
    const operation =
      download.downloadType === 'torrent'
        ? electronRpc.torrent.downloadTorrent(effectiveUrl, path)
        : electronRpc.torrent.downloadMagnet(effectiveUrl, path);
    const handshake = yield* downloadRpc(
      operation,
      download,
      'Failed to restart torrent download'
    );
    return handshake.id;
  });
}

export function restartDownload(
  pausedState: PausedDownloadState,
  pausedDownloadStates: Map<string, PausedDownloadState>
) {
  let newDownloadId = '';
  return Effect.gen(function* () {
    const latest = getDownloadItem(pausedState.id);
    if (!latest) return false;

    const download = { ...pausedState.downloadInfo, ...latest };
    newDownloadId = Math.random().toString(36).substring(7);
    pausedDownloadStates.delete(pausedState.id);
    updateDownloadStatus(pausedState.id, {
      id: newDownloadId,
      status: 'downloading',
      progress: download.progress || 0,
    });

    const actualId =
      download.downloadType === 'direct' || download.usedDebridService
        ? yield* restartDirectDownload(download)
        : download.downloadType === 'torrent' ||
            download.downloadType === 'magnet'
          ? yield* restartTorrentDownload(download)
          : yield* Effect.fail(
              new DownloadError({
                message: `Unsupported download type: ${download.downloadType}`,
                downloadId: download.id,
              })
            );
    updateDownloadStatus(newDownloadId, { id: actualId });
    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'info',
      message: `Restarted download: ${download.name}`,
    });
    return true;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        logger.sync.error('Error restarting download:', error);
        updateDownloadStatus(newDownloadId || pausedState.id, {
          status: 'error',
          error: 'Failed to restart download',
        });
        createNotification({
          id: Math.random().toString(36).substring(2, 9),
          type: 'error',
          message: `Failed to restart download: ${pausedState.downloadInfo.name}`,
        });
        return false;
      })
    )
  );
}
