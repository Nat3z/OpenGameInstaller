import { currentDownloads, type DownloadStatusAndInfo } from '../../store';

type PersistableStatus = 'downloading' | 'paused' | 'requesting' | 'seeding';

const PERSIST_DIR = './in-progress-downloads';

interface PersistedRecord {
  id: string;
  updatedAt: number;
  downloadInfo: DownloadStatusAndInfo;
}

const lastSavedAtById: Map<string, number> = new Map();

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
    status === 'requesting' ||
    status === 'seeding'
  );
}

function recordPath(id: string) {
  return `${PERSIST_DIR}/${id}.json`;
}

function saveRecord(download: DownloadStatusAndInfo) {
  try {
    const now = Date.now();
    const last = lastSavedAtById.get(download.id) || 0;
    if (now - last < 1000) return; // throttle per ID (1s)
    lastSavedAtById.set(download.id, now);

    const record: PersistedRecord = {
      id: download.id,
      updatedAt: now,
      downloadInfo: download,
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
    if (window.electronAPI.fs.exists(path)) {
      window.electronAPI.fs.delete(path);
    }
  } catch (e) {
    console.error('Failed to remove persisted download:', id, e);
  }
}

export async function loadPersistedDownloads(): Promise<
  DownloadStatusAndInfo[]
> {
  try {
    ensureDir();
    const files: string[] =
      (await window.electronAPI.fs.getFilesInDir(PERSIST_DIR)) || [];
    const restored: DownloadStatusAndInfo[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = window.electronAPI.fs.read(`${PERSIST_DIR}/${file}`);
        const parsed = JSON.parse(content) as PersistedRecord;
        if (!parsed || !parsed.downloadInfo) continue;
        const info = parsed.downloadInfo;
        if (!isPersistableStatus(info.status)) continue;
        // If this was a Debrid job but we never captured a resolved link, skip restoring it
        if (
          (info as any).usedDebridService &&
          (!info.downloadURL ||
            info.downloadURL === (info as any).originalDownloadURL)
        ) {
          // No resolved URL persisted; restoring this could fail on resume. Drop it.
          continue;
        }
        // After app restart, there is no live backend process bound to the ID; mark as paused for safety
        info.status = 'paused';
        restored.push(info);
      } catch (e) {
        console.error('Failed to parse persisted download:', file, e);
      }
    }
    return restored;
  } catch (e) {
    console.error('Failed to load persisted downloads:', e);
    return [];
  }
}

export async function initDownloadPersistence() {
  ensureDir();

  // 1) Hydrate store with any persisted in-progress downloads (mark as paused)
  try {
    const restored = await loadPersistedDownloads();
    if (restored && restored.length > 0) {
      currentDownloads.update((downloads) => {
        const byId = new Map(downloads.map((d) => [d.id, d] as const));
        restored.forEach((r) => {
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
  } catch (e) {
    console.error('Failed to hydrate persisted downloads:', e);
  }

  // 2) Subscribe to store and persist relevant states, cleanup completed/errored
  let lastSnapshot: Record<string, string> = {};
  currentDownloads.subscribe((downloads) => {
    try {
      const nextSnapshot: Record<string, string> = {};
      downloads.forEach((d) => {
        if (isPersistableStatus(d.status)) {
          const serialized = JSON.stringify(d);
          nextSnapshot[d.id] = serialized;
          if (lastSnapshot[d.id] !== serialized) {
            saveRecord(d);
          }
        } else {
          removeRecord(d.id);
        }
      });
      // Remove records for downloads that no longer exist in the store
      Object.keys(lastSnapshot).forEach((prevId) => {
        if (!(prevId in nextSnapshot)) {
          removeRecord(prevId);
        }
      });
      lastSnapshot = nextSnapshot;
    } catch (e) {
      console.error('Error while persisting in-progress downloads:', e);
    }
  });
}

export function deletePersistedDownload(id: string) {
  removeRecord(id);
}
