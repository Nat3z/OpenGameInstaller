/**
 * Cloud save sync: pack local paths and store locally (v1 file-based);
 * download from store and unpack into configured paths.
 * Path safety: only paths under allowed roots are used (enforced in manager).
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { join } from 'path';
import { __dirname } from '../manager/manager.paths.js';
import { setLastSyncTime } from '../manager/manager.cloudsave.js';

const CLOUDSAVE_STORE_DIR = join(__dirname, 'internals/cloudsave');
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB cap per app

async function getTotalSize(paths: string[]): Promise<number> {
  let total = 0;
  for (const p of paths) {
    const s = await fsp.stat(p).catch(() => null);
    if (!s) continue;
    if (s.isFile()) {
      total += s.size;
      if (total > MAX_TOTAL_BYTES) return total;
      continue;
    }
    const entries = await fsp.readdir(p, { withFileTypes: true }).catch(() => []);
    const stack = entries.map((e) => ({ dir: p, entry: e }));
    while (stack.length > 0) {
      const { dir, entry } = stack.pop()!;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await fsp.readdir(full, { withFileTypes: true }).catch(() => []);
        stack.push(...sub.map((e) => ({ dir: full, entry: e })));
      } else {
        const st = await fsp.stat(full).catch(() => null);
        if (st) total += st.size;
        if (total > MAX_TOTAL_BYTES) return total;
      }
    }
  }
  return total;
}

async function copyRecursive(
  src: string,
  dest: string,
  onProgress?: (progress: number) => void
): Promise<void> {
  const stat = await fsp.stat(src);
  if (stat.isFile()) {
    await fsp.mkdir(join(dest, '..'), { recursive: true });
    await fsp.copyFile(src, dest);
    onProgress?.(1);
    return;
  }
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  let done = 0;
  const total = entries.length;
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyRecursive(srcPath, destPath);
    } else {
      await fsp.copyFile(srcPath, destPath);
    }
    done++;
    if (total > 0) onProgress?.(done / total);
  }
}

async function copyRecursiveReverse(
  src: string,
  dest: string,
  onProgress?: (progress: number) => void
): Promise<void> {
  const stat = await fsp.stat(src);
  if (stat.isFile()) {
    await fsp.mkdir(join(dest, '..'), { recursive: true });
    await fsp.copyFile(src, dest);
    onProgress?.(1);
    return;
  }
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  let done = 0;
  const total = entries.length;
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyRecursiveReverse(srcPath, destPath);
    } else {
      await fsp.copyFile(srcPath, destPath);
    }
    done++;
    if (total > 0) onProgress?.(done / total);
  }
}

function ensureStoreDir(): void {
  if (!fs.existsSync(CLOUDSAVE_STORE_DIR)) {
    fs.mkdirSync(CLOUDSAVE_STORE_DIR, { recursive: true });
  }
}

/**
 * Upload (pack) local paths into internals/cloudsave/<appID>/.
 * Progress 0..1 over the list of paths.
 */
export async function uploadSave(
  appID: number,
  paths: string[],
  onProgress?: (progress: number) => void
): Promise<void> {
  const totalSize = await getTotalSize(paths);
  if (totalSize > MAX_TOTAL_BYTES) {
    throw new Error(
      `Cloud save size (${Math.round(totalSize / 1024 / 1024)} MB) exceeds limit (500 MB).`
    );
  }
  ensureStoreDir();
  const appDir = join(CLOUDSAVE_STORE_DIR, String(appID));
  if (fs.existsSync(appDir)) {
    await fsp.rm(appDir, { recursive: true });
  }
  await fsp.mkdir(appDir, { recursive: true });

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const stat = await fsp.stat(p).catch(() => null);
    if (!stat) continue;
    const destSub = join(appDir, String(i));
    await copyRecursive(p, destSub, (frac) =>
      onProgress?.((i + frac) / paths.length)
    );
  }

  setLastSyncTime(appID, 'up', Date.now());
  onProgress?.(1);
}

/**
 * Download (unpack) from internals/cloudsave/<appID>/ into the given paths.
 * Paths order must match the order used at upload (by index 0,1,...).
 */
export async function downloadSave(
  appID: number,
  paths: string[],
  onProgress?: (progress: number) => void
): Promise<void> {
  ensureStoreDir();
  const appDir = join(CLOUDSAVE_STORE_DIR, String(appID));
  if (!fs.existsSync(appDir)) {
    throw new Error('No cloud save found for this game.');
  }

  const entries = await fsp.readdir(appDir, { withFileTypes: true });
  const indices = entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => parseInt(e.name, 10))
    .sort((a, b) => a - b);

  for (let ii = 0; ii < indices.length; ii++) {
    const i = indices[ii];
    if (i >= paths.length) continue;
    const destPath = paths[i];
    const srcPath = join(appDir, String(i));
    await copyRecursiveReverse(srcPath, destPath, (frac) =>
      onProgress?.((ii + frac) / indices.length)
    );
  }

  setLastSyncTime(appID, 'down', Date.now());
  onProgress?.(1);
}
