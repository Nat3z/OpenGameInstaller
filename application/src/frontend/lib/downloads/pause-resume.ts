import {
  createNotification,
  currentDownloads,
  type DownloadStatusAndInfo,
} from '../../store';
import { getDownloadItem, updateDownloadStatus } from './lifecycle';
import { restartDownload } from '../downloads/restart';
import {
  deleteDownloadedItems,
  deletePersistedDownload,
} from '../downloads/persistence';

interface PausedDownloadState {
  id: string;
  downloadInfo: DownloadStatusAndInfo;
  pausedAt: number;
  originalDownloadURL?: string;
  files?: any[];
}

const pausedDownloadStates: Map<string, PausedDownloadState> = new Map();

// Track which resume operations have already triggered bulk queueing to avoid duplicates
const queuedAfterResume: Set<string> = new Set();

async function enqueueRemainingPausedDownloads(
  resumedId: string,
  pausedStates: Map<string, PausedDownloadState>
) {
  if (queuedAfterResume.has(resumedId)) return;
  queuedAfterResume.add(resumedId);

  // Build an ordered list of other paused items to enqueue behind the active one
  let downloadsSnapshot: DownloadStatusAndInfo[] = [] as any;
  currentDownloads.subscribe((d) => (downloadsSnapshot = d))();
  const toQueue = downloadsSnapshot.filter(
    (d) => d.id !== resumedId && d.status === 'paused'
  );

  // Enqueue sequentially to preserve order
  for (const item of toQueue) {
    try {
      // Skip if we lack the data needed to restart
      const itemDownloadURL =
        item.downloadType === 'torrent' || item.downloadType === 'magnet'
          ? item.downloadURL
          : undefined;
      const effectiveUrl = (item as any).usedDebridService
        ? itemDownloadURL || item.originalDownloadURL
        : item.originalDownloadURL || itemDownloadURL;
      const hasFiles =
        item.downloadType === 'direct' &&
        Array.isArray(item.files) &&
        item.files.length > 0;
      if (!effectiveUrl && !hasFiles) {
        continue;
      }

      // Construct a paused state for restart
      const state: PausedDownloadState = {
        id: item.id,
        downloadInfo: { ...item },
        pausedAt: Date.now(),
        originalDownloadURL: item.originalDownloadURL || itemDownloadURL,
        files: item.downloadType === 'direct' ? item.files : undefined,
      };
      pausedStates.set(item.id, state);
      // Restart to join the Electron queue; this will mark as 'downloading' and assign queue positions
      await restartDownload(state, pausedStates);
    } catch (e) {
      console.error(
        'Failed to enqueue paused download after resume:',
        item.id,
        e
      );
    }
  }
}

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
      originalDownloadURL:
        download.originalDownloadURL ||
        (download.downloadType === 'torrent' ||
        download.downloadType === 'magnet'
          ? download.downloadURL
          : undefined),
      files: download.downloadType === 'direct' ? download.files : undefined,
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
    const wasReconstructed = !pausedState;
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
          fallback.originalDownloadURL ||
          (fallback.downloadType === 'torrent' ||
          fallback.downloadType === 'magnet'
            ? fallback.downloadURL
            : undefined),
        files: fallback.downloadType === 'direct' ? fallback.files : undefined,
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

    // If this paused state was reconstructed after app restart, the backend has no handlers.
    // Skip in-place resume and restart the download directly.
    if (wasReconstructed) {
      console.log(
        'Reconstructed paused state with no backend context; restarting download instead of resuming.'
      );
      const ok = await restartDownload(pausedState, pausedDownloadStates);
      if (ok) {
        // Once one is set to downloading from persisted state, enqueue others in calculated order
        await enqueueRemainingPausedDownloads(downloadId, pausedDownloadStates);
      }
      return ok;
    }

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
      // Enqueue others only when resuming a reconstructed paused state
      // (No-op here for native resumes)
      return true;
    } else {
      console.log('In-place resume failed, attempting restart...');
      const ok = await restartDownload(pausedState, pausedDownloadStates);
      if (ok) {
        await enqueueRemainingPausedDownloads(downloadId, pausedDownloadStates);
      }
      return ok;
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
      deleteDownloadedItems(downloadId);
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
    deleteDownloadedItems(downloadId);
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
