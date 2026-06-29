import {
  createNotification,
  type DownloadStatusAndInfo,
} from '@/frontend/store';
import { getDownloadPath } from '@/frontend/lib/core/fs';
import {
  getDownloadItem,
  updateDownloadStatus,
} from '@/frontend/lib/downloads/lifecycle';
import {
  safeDownloadPath,
  sanitizePathSegment,
} from '@/frontend/lib/downloads/paths';

interface PausedDownloadState {
  id: string;
  downloadInfo: DownloadStatusAndInfo;
  pausedAt: number;
  originalDownloadURL?: string;
  files?: any[];
}

async function restartDirectDownload(
  download: DownloadStatusAndInfo
): Promise<string> {
  const downloadURL =
    download.downloadType === 'torrent' || download.downloadType === 'magnet'
      ? download.downloadURL
      : undefined;
  const effectiveUrl = download.usedDebridService
    ? downloadURL || download.originalDownloadURL
    : download.originalDownloadURL || downloadURL;

  let files: {
    link: string;
    path: string;
    headers?: Record<string, string>;
  }[] = [];

  const downloadFiles =
    download.files && download.files.length > 0 ? download.files : undefined;
  if (downloadFiles && downloadFiles.length > 0) {
    const baseDir = getDownloadPath();
    files = downloadFiles.map((file) => ({
      link: file.downloadURL,
      path:
        file.path ??
        safeDownloadPath(baseDir, download.name, file.name),
      headers: file.headers,
    }));
  } else if (effectiveUrl) {
    const deriveFilenameFromUrl = (url?: string): string | undefined => {
      if (!url) return undefined;
      try {
        const u = new URL(url);
        const last = u.pathname.split('/').pop();
        return last && last.length > 0 ? decodeURIComponent(last) : undefined;
      } catch (e) {
        const parts = url.split(/[\\\/]/);
        return parts.length > 0 ? parts[parts.length - 1] : undefined;
      }
    };
    const urlFilename = deriveFilenameFromUrl(effectiveUrl);

    const isFilePath =
      typeof download.downloadPath === 'string' &&
      !download.downloadPath.endsWith('/') &&
      !download.downloadPath.endsWith('\\');

    let targetPath: string;
    if (isFilePath) {
      targetPath = download.downloadPath;
    } else {
      const downloadFilename =
        download.downloadType === 'torrent' ||
        download.downloadType === 'magnet'
          ? download.filename
          : undefined;
      const filenameHasExt =
        !!downloadFilename && /\.[A-Za-z0-9]{1,8}$/.test(downloadFilename);
      const chosenFilename =
        (urlFilename && /\.[A-Za-z0-9]{1,8}$/.test(urlFilename)
          ? urlFilename
          : undefined) ||
        (filenameHasExt ? downloadFilename : undefined) ||
        downloadFilename ||
        urlFilename ||
        'download';
      targetPath = safeDownloadPath(
        getDownloadPath(),
        download.name,
        chosenFilename
      );
    }
    files = [
      {
        link: effectiveUrl,
        path: targetPath,
      },
    ];
  } else {
    throw new Error('No download URL available for restart');
  }

  console.log('Restarting direct download with files:', files);
  console.log('Download part:', download.part);
  console.log('Download total parts:', download.totalParts);
  const handshake = await window.electronAPI.ddl.download(files, download.part);
  return handshake.id;
}

async function restartTorrentDownload(
  download: DownloadStatusAndInfo
): Promise<string> {
  const downloadURL =
    download.downloadType === 'torrent' || download.downloadType === 'magnet'
      ? download.downloadURL
      : undefined;
  const effectiveUrl = download.usedDebridService
    ? downloadURL || download.originalDownloadURL
    : download.originalDownloadURL || downloadURL;
  if (!effectiveUrl) {
    throw new Error('No torrent URL available for restart');
  }

  const persistedFilePath = download.files?.[0]?.path;
  const folderPath =
    download.downloadPath.endsWith('/') ||
    download.downloadPath.endsWith('\\')
      ? download.downloadPath
      : persistedFilePath
        ? persistedFilePath.replace(/[/\\][^/\\]+$/, '/')
        : safeDownloadPath(getDownloadPath(), download.name);

  if (folderPath) {
    console.log(
      'Restarting torrent download:',
      effectiveUrl,
      'to path:',
      folderPath
    );
    if (download.downloadType === 'torrent') {
      const handshake = await window.electronAPI.torrent.downloadTorrent(
        effectiveUrl,
        folderPath
      );
      return handshake.id;
    } else if (download.downloadType === 'magnet') {
      const handshake = await window.electronAPI.torrent.downloadMagnet(
        effectiveUrl,
        folderPath
      );
      return handshake.id;
    }
  }

  let filename =
    download.downloadType === 'torrent' || download.downloadType === 'magnet'
      ? download.filename
      : undefined;
  if (!filename) {
    if (download.downloadType === 'magnet') {
      const magnetMatch = effectiveUrl.match(/dn=([^&]*)/);
      if (magnetMatch) {
        filename = decodeURIComponent(magnetMatch[1]);
      } else {
        filename = download.name || 'torrent_download';
      }
    } else {
      const urlParts = effectiveUrl.split(/[\\/]/);
      const lastPart = urlParts[urlParts.length - 1];
      if (lastPart && lastPart.includes('.')) {
        filename = lastPart;
      } else {
        filename = download.name || 'torrent_download';
      }
    }
    filename = sanitizePathSegment(filename);
  }

  const path = safeDownloadPath(getDownloadPath(), download.name);

  console.log('Restarting torrent download:', effectiveUrl, 'to path:', path);

  if (download.downloadType === 'torrent') {
    const handshake = await window.electronAPI.torrent.downloadTorrent(
      effectiveUrl,
      path
    );
    return handshake.id;
  } else if (download.downloadType === 'magnet') {
    const handshake = await window.electronAPI.torrent.downloadMagnet(
      effectiveUrl,
      path
    );
    return handshake.id;
  } else {
    throw new Error(
      `Unsupported torrent download type: ${download.downloadType}`
    );
  }
}

export async function restartDownload(
  pausedState: PausedDownloadState,
  pausedDownloadStates: Map<string, PausedDownloadState>
): Promise<boolean> {
  let newDownloadId = '';
  try {
    const latestDownload = getDownloadItem(pausedState.id);
    if (!latestDownload) {
      console.warn(
        'Skipping restart for missing download state:',
        pausedState.id
      );
      return false;
    }

    const download = { ...pausedState.downloadInfo, ...latestDownload };
    console.log('Restarting download:', download.name);

    newDownloadId = Math.random().toString(36).substring(7);

    pausedDownloadStates.delete(pausedState.id);

    updateDownloadStatus(pausedState.id, {
      id: newDownloadId,
      status: 'downloading',
      progress: download.progress || 0,
    });

    let newActualDownloadId: string;

    if (download.downloadType === 'direct' || download.usedDebridService) {
      newActualDownloadId = await restartDirectDownload(download);
    } else if (
      download.downloadType === 'torrent' ||
      download.downloadType === 'magnet'
    ) {
      newActualDownloadId = await restartTorrentDownload(download);
    } else {
      throw new Error(`Unsupported download type: ${download.downloadType}`);
    }

    updateDownloadStatus(newDownloadId, { id: newActualDownloadId });

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'info',
      message: `Restarted download: ${download.name}`,
    });

    return true;
  } catch (error) {
    console.error('Error restarting download:', error);

    if (newDownloadId) {
      updateDownloadStatus(newDownloadId, {
        status: 'error',
        error: 'Failed to restart download',
      });
    } else {
      updateDownloadStatus(pausedState.id, {
        status: 'error',
        error: 'Failed to restart download',
      });
    }

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: `Failed to restart download: ${pausedState.downloadInfo.name}`,
    });

    return false;
  }
}
