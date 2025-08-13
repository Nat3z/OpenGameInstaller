import { createNotification, type DownloadStatusAndInfo } from '../../store';
import { getDownloadPath } from '../core/fs';
import { updateDownloadStatus } from './lifecycle';

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
  // Prefer the latest resolved URL for Debrid services. Fall back otherwise.
  const effectiveUrl = download.usedDebridService
    ? download.downloadURL || download.originalDownloadURL
    : download.originalDownloadURL || download.downloadURL;

  let files: {
    link: string;
    path: string;
    headers?: Record<string, string>;
  }[] = [];

  if (download.files && download.files.length > 0) {
    // Multi-part download
    files = download.files.map((file: any) => ({
      link: file.downloadURL,
      path: getDownloadPath() + '/' + download.name + '/' + file.name,
      headers: file.headers,
    }));
  } else if (effectiveUrl) {
    // Single file download
    const filename =
      download.filename || effectiveUrl.split(/\\|/).pop() || 'download';
    files = [
      {
        link: effectiveUrl,
        path: getDownloadPath() + '/' + download.name + '/' + filename,
      },
    ];
  } else {
    throw new Error('No download URL available for restart');
  }

  console.log('Restarting direct download with files:', files);
  return await window.electronAPI.ddl.download(files);
}

async function restartTorrentDownload(
  download: DownloadStatusAndInfo
): Promise<string> {
  // For torrent/magnet restarts, prefer the latest link if Debrid provided a new one.
  const effectiveUrl = download.usedDebridService
    ? download.downloadURL || download.originalDownloadURL
    : download.originalDownloadURL || download.downloadURL;
  if (!effectiveUrl) {
    throw new Error('No torrent URL available for restart');
  }

  // Generate a safe filename fallback
  let filename = download.filename;
  if (!filename) {
    if (download.downloadType === 'magnet') {
      // For magnet links, extract name from the magnet URI or use a generic name
      const magnetMatch = effectiveUrl.match(/dn=([^&]*)/);
      if (magnetMatch) {
        filename = decodeURIComponent(magnetMatch[1]);
      } else {
        filename = download.name || 'torrent_download';
      }
    } else {
      // For torrent files, try to extract filename from URL
      const urlParts = effectiveUrl.split(/[\\/]/);
      const lastPart = urlParts[urlParts.length - 1];
      if (lastPart && lastPart.includes('.')) {
        filename = lastPart;
      } else {
        filename = download.name || 'torrent_download';
      }
    }
    // Sanitize filename to remove invalid characters and limit length
    filename = filename.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
  }

  const path = getDownloadPath() + '/' + download.name + '/' + filename;

  console.log('Restarting torrent download:', effectiveUrl, 'to path:', path);

  if (download.downloadType === 'torrent') {
    return await window.electronAPI.torrent.downloadTorrent(effectiveUrl, path);
  } else if (download.downloadType === 'magnet') {
    return await window.electronAPI.torrent.downloadMagnet(effectiveUrl, path);
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
  try {
    const download = pausedState.downloadInfo;
    console.log('Restarting download:', download.name);

    // Generate new download ID to avoid conflicts
    const newDownloadId = Math.random().toString(36).substring(7);

    // Clean up old paused state
    pausedDownloadStates.delete(pausedState.id);

    // Update the download with new ID
    updateDownloadStatus(pausedState.id, {
      id: newDownloadId,
      status: 'downloading',
      progress: download.progress || 0,
    });

    let newActualDownloadId: string;

    // Restart based on download type
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

    // Update with the actual download ID returned by the backend
    updateDownloadStatus(newDownloadId, { id: newActualDownloadId });

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'info',
      message: `Restarted download: ${download.name}`,
    });

    return true;
  } catch (error) {
    console.error('Error restarting download:', error);

    updateDownloadStatus(pausedState.id, {
      status: 'error',
      error: 'Failed to restart download',
    });

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: `Failed to restart download: ${pausedState.downloadInfo.name}`,
    });

    return false;
  }
}
