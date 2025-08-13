import {
  createNotification,
  currentDownloads,
  type DownloadStatusAndInfo,
} from '../../store';
import { getDownloadItem, updateDownloadStatus } from './lifecycle';
import { restartDownload } from '../downloads/restart';
import { deletePersistedDownload } from '../downloads/persistence';

interface PausedDownloadState {
  id: string;
  downloadInfo: DownloadStatusAndInfo;
  pausedAt: number;
  originalDownloadURL?: string;
  files?: any[];
}

const pausedDownloadStates: Map<string, PausedDownloadState> = new Map();

export async function pauseDownload(downloadId: string): Promise<boolean> {
  try {
    const download = getDownloadItem(downloadId);
    if (!download) {
      console.log('No download found for ID:', downloadId);
      return false;
    }

    console.log('Pausing download:', downloadId, download.name);

    const pausedState: PausedDownloadState = {
      id: downloadId,
      downloadInfo: { ...download },
      pausedAt: Date.now(),
      originalDownloadURL: download.originalDownloadURL || download.downloadURL,
      files: download.files,
    };

    pausedDownloadStates.set(downloadId, pausedState);
    updateDownloadStatus(downloadId, { status: 'paused' });

    let pauseResult = false;
    if (download.downloadType === 'direct' || download.usedDebridService) {
      try {
        await window.electronAPI.ddl.pauseDownload(downloadId);
        pauseResult = true;
      } catch (error) {
        console.error('Failed to pause direct download:', error);
        pauseResult = false;
      }
    } else if (
      download.downloadType === 'torrent' ||
      download.downloadType === 'magnet'
    ) {
      try {
        await window.electronAPI.torrent.pauseDownload(downloadId);
        pauseResult = true;
      } catch (error) {
        console.error('Failed to pause torrent download:', error);
        pauseResult = false;
      }
    }

    if (pauseResult) {
      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'info',
        message: `Paused download: ${download.name}`,
      });
      return true;
    } else {
      pausedDownloadStates.delete(downloadId);
      updateDownloadStatus(downloadId, { status: 'downloading' });
      return false;
    }
  } catch (error) {
    console.error('Error pausing download:', error);
    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: 'Failed to pause download',
    });
    return false;
  }
}

export async function resumeDownload(downloadId: string): Promise<boolean> {
  try {
    console.log('Attempting to resume download:', downloadId);

    let pausedState = pausedDownloadStates.get(downloadId);
    if (!pausedState) {
      // Fallback: reconstruct paused state from current store (e.g., after app restart)
      const fallback = getDownloadItem(downloadId);
      if (!fallback) {
        console.log('No paused download state found for', downloadId);
        return false;
      }
      pausedState = {
        id: downloadId,
        downloadInfo: { ...fallback },
        pausedAt: Date.now(),
        originalDownloadURL:
          fallback.originalDownloadURL || fallback.downloadURL,
        files: fallback.files,
      };
      pausedDownloadStates.set(downloadId, pausedState);
    }

    const download = pausedState.downloadInfo;
    console.log(
      'Resuming download:',
      download.name,
      'Type:',
      download.downloadType
    );

    updateDownloadStatus(downloadId, { status: 'downloading' });

    let resumeResult = false;
    if (download.downloadType === 'direct' || download.usedDebridService) {
      try {
        await window.electronAPI.ddl.resumeDownload(downloadId);
        resumeResult = true;
      } catch (error) {
        console.error('Failed to resume direct download:', error);
        resumeResult = false;
      }
    } else if (
      download.downloadType === 'torrent' ||
      download.downloadType === 'magnet'
    ) {
      try {
        await window.electronAPI.torrent.resumeDownload(downloadId);
        resumeResult = true;
      } catch (error) {
        console.error('Failed to resume torrent download:', error);
        resumeResult = false;
      }
    }

    if (resumeResult) {
      pausedDownloadStates.delete(downloadId);

      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'info',
        message: `Resumed download: ${download.name}`,
      });
      // ensure only the current ID persists
      deletePersistedDownload(downloadId);
      return true;
    } else {
      console.log('In-place resume failed, attempting restart...');
      return await restartDownload(pausedState, pausedDownloadStates);
    }
  } catch (error) {
    console.error('Error resuming download:', error);

    updateDownloadStatus(downloadId, {
      status: 'error',
      error:
        error instanceof Error ? error.message : 'Failed to resume download',
    });

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message:
        error instanceof Error ? error.message : 'Failed to resume download',
    });
    return false;
  }
}

export function cancelPausedDownload(downloadId: string) {
  try {
    const pausedState = pausedDownloadStates.get(downloadId);
    if (!pausedState) {
      // Handle persisted paused downloads after app restart (no in-memory state)
      const item = getDownloadItem(downloadId);
      deletePersistedDownload(downloadId);
      currentDownloads.update((downloads) => {
        return downloads.filter((d) => d.id !== downloadId);
      });
      if (item) {
        createNotification({
          id: Math.random().toString(36).substring(2, 9),
          type: 'info',
          message: `Cancelled download: ${item.name}`,
        });
      }
      return;
    }

    pausedDownloadStates.delete(downloadId);

    currentDownloads.update((downloads) => {
      return downloads.filter((d) => d.id !== downloadId);
    });

    window.electronAPI.ddl.abortDownload(downloadId);
    deletePersistedDownload(downloadId);

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'info',
      message: `Cancelled download: ${pausedState.downloadInfo.name}`,
    });
  } catch (error) {
    console.error('Error cancelling paused download:', error);
    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: 'Failed to cancel download',
    });
  }
}
