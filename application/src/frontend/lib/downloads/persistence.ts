import {
  currentDownloads,
  protonPrefixSetups,
  type DownloadStatusAndInfo,
  type ProtonPrefixSetup,
} from '../../store';
import { get } from 'svelte/store';
import { restartDownload } from './restart';

type PersistableStatus = 'downloading' | 'paused' | 'proton-prefix-setup';

const PERSIST_DIR = './in-progress-downloads';

interface PersistedRecord {
  id: string;
  updatedAt: number;
  downloadInfo: DownloadStatusAndInfo;
  protonPrefixSetup?: ProtonPrefixSetup;
}

const lastSavedAtById: Map<string, number> = new Map();
const restoredIds: Set<string> = new Set();
let hasEnqueuedRestoredAfterAnyStart = false;

// Local minimal type to interop with restartDownload
interface PausedDownloadStateLike {
  id: string;
  downloadInfo: DownloadStatusAndInfo;
  pausedAt: number;
  originalDownloadURL?: string;
  files?: any[];
}

const localPausedMap = new Map<string, PausedDownloadStateLike>();

function ensureDir() {
  try {
    if (!window.electronAPI.fs.exists(PERSIST_DIR)) {
      window.electronAPI.fs.mkdir(PERSIST_DIR);
    }
  } catch (e) {
    console.error('Failed to ensure persist dir:', e);
  }
}

function isPersistableStatus(
  status: string | undefined
): status is PersistableStatus {
  return (
    status === 'downloading' ||
    status === 'paused' ||
    status === 'proton-prefix-setup'
  );
}

function recordPath(id: string) {
  return `${PERSIST_DIR}/${id}.json`;
}

function saveRecord(download: DownloadStatusAndInfo, force = false) {
  try {
    const now = Date.now();
    const last = lastSavedAtById.get(download.id) || 0;
    if (!force && now - last < 1000) return; // throttle per ID (1s)
    lastSavedAtById.set(download.id, now);

    const maybeProtonPrefixSetup =
      download.status === 'proton-prefix-setup'
        ? get(protonPrefixSetups)[download.id]
        : undefined;

    const record: PersistedRecord = {
      id: download.id,
      updatedAt: now,
      downloadInfo: download,
      ...(maybeProtonPrefixSetup
        ? { protonPrefixSetup: maybeProtonPrefixSetup }
        : {}),
    };
    window.electronAPI.fs.write(
      recordPath(download.id),
      JSON.stringify(record, null, 2)
    );
  } catch (e) {
    console.error('Failed to persist in-progress download:', download.id, e);
  }
}

function removeRecord(id: string) {
  try {
    const path = recordPath(id);
    // if (window.electronAPI.fs.exists(path)) {
    window.electronAPI.fs.delete(path);
    // }
  } catch (e) {
    console.error('Failed to remove persisted download:', id, e);
  }
}

function isProtonPrefixSetup(value: unknown): value is ProtonPrefixSetup {
  if (typeof value !== 'object' || value === null) return false;
  const setup = value as ProtonPrefixSetup;
  const validSteps: ProtonPrefixSetup['step'][] = [
    'added-to-steam',
    'kill-steam',
    'start-steam',
    'launch-game',
    'waiting-prefix',
    'ready',
  ];
  return (
    typeof setup.downloadId === 'string' &&
    typeof setup.appID === 'number' &&
    typeof setup.gameName === 'string' &&
    typeof setup.addonSource === 'string' &&
    Array.isArray(setup.redistributables) &&
    setup.redistributables.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.name === 'string' &&
        typeof item.path === 'string'
    ) &&
    typeof setup.prefixPath === 'string' &&
    typeof setup.prefixExists === 'boolean' &&
    validSteps.includes(setup.step)
  );
}

export async function loadPersistedDownloads(): Promise<
  {
    downloads: DownloadStatusAndInfo[];
    protonPrefixSetupByDownloadId: Record<string, ProtonPrefixSetup>;
  }
> {
  try {
    ensureDir();
    // Do not pre-assign queue positions on restore. All items will be paused
    // and queue positions are resolved when a resume occurs.
    const files: string[] =
      (await window.electronAPI.fs.getFilesInDir(PERSIST_DIR)) || [];
    const restored: DownloadStatusAndInfo[] = [];
    const protonPrefixSetupByDownloadId: Record<string, ProtonPrefixSetup> = {};
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = window.electronAPI.fs.read(`${PERSIST_DIR}/${file}`);
        const parsed = JSON.parse(content) as PersistedRecord;
        if (!parsed || !parsed.downloadInfo) continue;
        const info = parsed.downloadInfo;
        if (!isPersistableStatus(info.status)) continue;
        if (info.status === 'proton-prefix-setup') {
          if (isProtonPrefixSetup(parsed.protonPrefixSetup)) {
            protonPrefixSetupByDownloadId[info.id] = parsed.protonPrefixSetup;
          }
          restored.push(info);
          continue;
        }
        // If this was a Debrid job but we never captured a resolved link, skip restoring it
        if (
          info.usedDebridService &&
          (info.downloadType === 'torrent' || info.downloadType === 'magnet') &&
          (!info.downloadURL || info.downloadURL === info.originalDownloadURL)
        ) {
          // No resolved URL persisted; restoring this could fail on resume. Drop it.
          continue;
        }
        // After app restart, there is no live backend process bound to the ID; mark as paused for safety
        info.status = 'paused';
        // Drop any stale queue position; it will be resolved on resume
        info.queuePosition = undefined;
        restored.push(info);
      } catch (e) {
        console.error('Failed to parse persisted download:', file, e);
      }
    }
    return { downloads: restored, protonPrefixSetupByDownloadId };
  } catch (e) {
    console.error('Failed to load persisted downloads:', e);
    return { downloads: [], protonPrefixSetupByDownloadId: {} };
  }
}

export async function initDownloadPersistence() {
  ensureDir();

  // 1) Hydrate store with any persisted in-progress downloads (mark as paused)
  try {
    const restoredState = await loadPersistedDownloads();
    if (restoredState.downloads.length > 0) {
      restoredState.downloads.forEach((r) => {
        if (r.status === 'paused') {
          restoredIds.add(r.id);
        }
      });
      currentDownloads.update((downloads) => {
        const byId = new Map(downloads.map((d) => [d.id, d] as const));
        restoredState.downloads.forEach((r) => {
          if (!byId.has(r.id)) {
            byId.set(r.id, r);
          } else {
            const existing = byId.get(r.id)!;
            byId.set(r.id, { ...existing, ...r });
          }
        });
        return Array.from(byId.values());
      });
    }

    const restoredPrefixSetupIds = Object.keys(
      restoredState.protonPrefixSetupByDownloadId
    );
    if (restoredPrefixSetupIds.length > 0) {
      protonPrefixSetups.update((setups) => ({
        ...setups,
        ...restoredState.protonPrefixSetupByDownloadId,
      }));
    }
  } catch (e) {
    console.error('Failed to hydrate persisted downloads:', e);
  }

  // 2) Subscribe to store and persist relevant states, cleanup completed/errored
  let lastSnapshot: Record<string, string> = {};
  let lastPrefixSetupSnapshotById: Record<string, string> = {};
  let latestDownloads: DownloadStatusAndInfo[] = [];
  currentDownloads.subscribe((downloads) => {
    try {
      latestDownloads = downloads;
      // If a new download has started anywhere and we still have restored paused items,
      // rebuild the queue by enqueuing those paused items behind the active one.
      if (!hasEnqueuedRestoredAfterAnyStart && restoredIds.size > 0) {
        const hasActive = downloads.some((d) => d.status === 'downloading');
        if (hasActive) {
          hasEnqueuedRestoredAfterAnyStart = true;
          // Enqueue asynchronously to avoid blocking the subscriber
          (async () => {
            const toEnqueue = downloads.filter(
              (d) => d.status === 'paused' && restoredIds.has(d.id)
            );
            for (const item of toEnqueue) {
              try {
                const state: PausedDownloadStateLike = {
                  id: item.id,
                  downloadInfo: { ...item },
                  pausedAt: Date.now(),
                  originalDownloadURL:
                    item.originalDownloadURL ||
                    (item.downloadType === 'torrent' ||
                    item.downloadType === 'magnet'
                      ? item.downloadURL
                      : undefined),
                  files:
                    item.downloadType === 'direct' ? item.files : undefined,
                };
                localPausedMap.set(item.id, state);
                const ok = await restartDownload(state, localPausedMap);
                if (ok) restoredIds.delete(item.id);
              } catch (err) {
                console.error(
                  'Failed to enqueue restored paused download:',
                  item.id,
                  err
                );
              }
            }
          })();
        }
      }

      const nextSnapshot: Record<string, string> = {};
      downloads.forEach((d) => {
        if (isPersistableStatus(d.status)) {
          const serialized = JSON.stringify(d);
          nextSnapshot[d.id] = serialized;
          if (lastSnapshot[d.id] !== serialized) {
            saveRecord(d);
          }
        }
      });
      // Remove records for downloads that no longer exist in the store
      Object.keys(lastSnapshot).forEach((prevId) => {
        if (!(prevId in nextSnapshot)) {
          console.log('[persistence] Removing record for download:', prevId);
          removeRecord(prevId);
          delete lastPrefixSetupSnapshotById[prevId];
        }
      });
      lastSnapshot = nextSnapshot;
    } catch (e) {
      console.error('Error while persisting in-progress downloads:', e);
    }
  });

  protonPrefixSetups.subscribe((setups) => {
    try {
      const downloadsById = new Map(
        latestDownloads.map((download) => [download.id, download] as const)
      );
      Object.entries(setups).forEach(([downloadId, setup]) => {
        const download = downloadsById.get(downloadId);
        if (!download || download.status !== 'proton-prefix-setup') return;

        const serialized = JSON.stringify(setup);
        if (lastPrefixSetupSnapshotById[downloadId] !== serialized) {
          saveRecord(download, true);
          lastPrefixSetupSnapshotById[downloadId] = serialized;
        }
      });

      Object.keys(lastPrefixSetupSnapshotById).forEach((downloadId) => {
        if (!setups[downloadId]) {
          delete lastPrefixSetupSnapshotById[downloadId];
        }
      });
    } catch (e) {
      console.error('Error while persisting proton prefix setup state:', e);
    }
  });
}

export async function deleteDownloadedItems(id: string) {
  const record = recordPath(id);
  if (!window.electronAPI.fs.exists(record)) return;
  const content = window.electronAPI.fs.read(record);
  const parsed = JSON.parse(content) as PersistedRecord;
  const downloadInfo = parsed.downloadInfo;
  
  // Normalize and resolve the path correctly
  let downloadFolder = downloadInfo.downloadPath;
  // Remove trailing slashes
  downloadFolder = downloadFolder.replace(/[/\\]+$/, '');
  // Get directory name (parent directory)
  const lastSlash = Math.max(downloadFolder.lastIndexOf('/'), downloadFolder.lastIndexOf('\\'));
  if (lastSlash !== -1) {
    downloadFolder = downloadFolder.slice(0, lastSlash);
  }
  
  // Only delete files that belong to this specific download
  // Derive exact file paths from downloadInfo
  const filesToDelete: string[] = [];
  
  if (downloadInfo.files && Array.isArray(downloadInfo.files)) {
    // Multi-part download - delete specific files
    for (const file of downloadInfo.files) {
      if (file.name) {
        filesToDelete.push(downloadFolder + '/' + file.name);
      }
    }
  } else if ('filename' in downloadInfo && downloadInfo.filename) {
    // Single file download - delete the specific file
    filesToDelete.push(downloadFolder + '/' + downloadInfo.filename);
  }
  
  // Delete only the validated files
  for (const filePath of filesToDelete) {
    try {
      await window.electronAPI.fs.deleteAsync(filePath);
    } catch (err) {
      console.error('Failed to delete file:', filePath, err);
    }
  }
}
export function deletePersistedDownload(id: string) {
  removeRecord(id);
}
