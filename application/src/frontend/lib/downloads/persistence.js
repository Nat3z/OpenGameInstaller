import { currentDownloads } from '../../store';
import { restartDownload } from './restart';
const PERSIST_DIR = './in-progress-downloads';
const lastSavedAtById = new Map();
const restoredIds = new Set();
let hasEnqueuedRestoredAfterAnyStart = false;
const localPausedMap = new Map();
function ensureDir() {
    try {
        if (!window.electronAPI.fs.exists(PERSIST_DIR)) {
            window.electronAPI.fs.mkdir(PERSIST_DIR);
        }
    }
    catch (e) {
        console.error('Failed to ensure persist dir:', e);
    }
}
function isPersistableStatus(status) {
    return status === 'downloading' || status === 'paused';
}
function recordPath(id) {
    return `${PERSIST_DIR}/${id}.json`;
}
function saveRecord(download) {
    try {
        const now = Date.now();
        const last = lastSavedAtById.get(download.id) || 0;
        if (now - last < 1000)
            return; // throttle per ID (1s)
        lastSavedAtById.set(download.id, now);
        const record = {
            id: download.id,
            updatedAt: now,
            downloadInfo: download,
        };
        window.electronAPI.fs.write(recordPath(download.id), JSON.stringify(record, null, 2));
    }
    catch (e) {
        console.error('Failed to persist in-progress download:', download.id, e);
    }
}
function removeRecord(id) {
    try {
        const path = recordPath(id);
        // if (window.electronAPI.fs.exists(path)) {
        window.electronAPI.fs.delete(path);
        // }
    }
    catch (e) {
        console.error('Failed to remove persisted download:', id, e);
    }
}
export async function loadPersistedDownloads() {
    try {
        ensureDir();
        // Do not pre-assign queue positions on restore. All items will be paused
        // and queue positions are resolved when a resume occurs.
        const files = (await window.electronAPI.fs.getFilesInDir(PERSIST_DIR)) || [];
        const restored = [];
        for (const file of files) {
            if (!file.endsWith('.json'))
                continue;
            try {
                const content = window.electronAPI.fs.read(`${PERSIST_DIR}/${file}`);
                const parsed = JSON.parse(content);
                if (!parsed || !parsed.downloadInfo)
                    continue;
                const info = parsed.downloadInfo;
                if (!isPersistableStatus(info.status))
                    continue;
                // If this was a Debrid job but we never captured a resolved link, skip restoring it
                if (info.usedDebridService &&
                    (info.downloadType === 'torrent' || info.downloadType === 'magnet') &&
                    (!info.downloadURL || info.downloadURL === info.originalDownloadURL)) {
                    // No resolved URL persisted; restoring this could fail on resume. Drop it.
                    continue;
                }
                // After app restart, there is no live backend process bound to the ID; mark as paused for safety
                info.status = 'paused';
                // Drop any stale queue position; it will be resolved on resume
                info.queuePosition = undefined;
                restored.push(info);
            }
            catch (e) {
                console.error('Failed to parse persisted download:', file, e);
            }
        }
        return restored;
    }
    catch (e) {
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
            restored.forEach((r) => restoredIds.add(r.id));
            currentDownloads.update((downloads) => {
                const byId = new Map(downloads.map((d) => [d.id, d]));
                restored.forEach((r) => {
                    if (!byId.has(r.id)) {
                        byId.set(r.id, r);
                    }
                    else {
                        const existing = byId.get(r.id);
                        byId.set(r.id, { ...existing, ...r });
                    }
                });
                return Array.from(byId.values());
            });
        }
    }
    catch (e) {
        console.error('Failed to hydrate persisted downloads:', e);
    }
    // 2) Subscribe to store and persist relevant states, cleanup completed/errored
    let lastSnapshot = {};
    currentDownloads.subscribe((downloads) => {
        try {
            // If a new download has started anywhere and we still have restored paused items,
            // rebuild the queue by enqueuing those paused items behind the active one.
            if (!hasEnqueuedRestoredAfterAnyStart && restoredIds.size > 0) {
                const hasActive = downloads.some((d) => d.status === 'downloading');
                if (hasActive) {
                    hasEnqueuedRestoredAfterAnyStart = true;
                    // Enqueue asynchronously to avoid blocking the subscriber
                    (async () => {
                        const toEnqueue = downloads.filter((d) => d.status === 'paused' && restoredIds.has(d.id));
                        for (const item of toEnqueue) {
                            try {
                                const state = {
                                    id: item.id,
                                    downloadInfo: { ...item },
                                    pausedAt: Date.now(),
                                    originalDownloadURL: item.originalDownloadURL ||
                                        (item.downloadType === 'torrent' ||
                                            item.downloadType === 'magnet'
                                            ? item.downloadURL
                                            : undefined),
                                    files: item.downloadType === 'direct' ? item.files : undefined,
                                };
                                localPausedMap.set(item.id, state);
                                const ok = await restartDownload(state, localPausedMap);
                                if (ok)
                                    restoredIds.delete(item.id);
                            }
                            catch (err) {
                                console.error('Failed to enqueue restored paused download:', item.id, err);
                            }
                        }
                    })();
                }
            }
            const nextSnapshot = {};
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
                }
            });
            lastSnapshot = nextSnapshot;
        }
        catch (e) {
            console.error('Error while persisting in-progress downloads:', e);
        }
    });
}
export async function deleteDownloadedItems(id) {
    const record = recordPath(id);
    if (!window.electronAPI.fs.exists(record))
        return;
    const content = window.electronAPI.fs.read(record);
    const parsed = JSON.parse(content);
    const downloadInfo = parsed.downloadInfo;
    let downloadFolder = downloadInfo.downloadPath
        .split('/')
        .slice(0, -1)
        .join('/');
    window.electronAPI.fs.getFilesInDir(downloadFolder).then((files) => {
        files.forEach((file) => {
            window.electronAPI.fs.deleteAsync(downloadFolder + '/' + file);
        });
    });
}
export function deletePersistedDownload(id) {
    removeRecord(id);
}
//# sourceMappingURL=persistence.js.map