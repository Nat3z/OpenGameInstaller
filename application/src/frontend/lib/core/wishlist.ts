import type { BasicLibraryInfo } from 'ogi-addon';
import { wishlist } from '../../store';

const WISHLIST_PATH = './internals/wishlist.json';
const INTERNALS_DIR = './internals';

function ensureInternals(): void {
  if (!window.electronAPI.fs.exists(INTERNALS_DIR)) {
    window.electronAPI.fs.mkdir(INTERNALS_DIR);
  }
}

function parseWishlistJson(raw: string): BasicLibraryInfo[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e: unknown): e is BasicLibraryInfo => {
      if (e === null || typeof e !== 'object') return false;
      const entry = e as Record<string, unknown>;
      return (
        typeof entry.name === 'string' &&
        typeof entry.capsuleImage === 'string' &&
        typeof entry.appID === 'number' &&
        typeof entry.storefront === 'string'
      );
    });
  } catch {
    return [];
  }
}

/**
 * Read and validate wishlist from disk. Returns null on read error so callers can avoid desync.
 */
function readWishlistFromDisk(): BasicLibraryInfo[] | null {
  ensureInternals();
  const raw = window.electronAPI.fs.exists(WISHLIST_PATH)
    ? window.electronAPI.fs.read(WISHLIST_PATH)
    : '[]';
  if (typeof raw !== 'string') {
    console.error('[wishlist] Failed to read wishlist from disk');
    return null;
  }
  return parseWishlistJson(raw);
}

/**
 * Load wishlist from disk and sync the store. Returns entries; empty array if missing/invalid.
 */
export function loadWishlist(): BasicLibraryInfo[] {
  const entries = readWishlistFromDisk();
  if (entries === null) {
    wishlist.set([]);
    return [];
  }
  wishlist.set(entries);
  return entries;
}

/**
 * Write wishlist to disk. Returns true on success. Caller should update the store only when true.
 */
function saveWishlistSync(entries: BasicLibraryInfo[]): boolean {
  ensureInternals();
  const result = window.electronAPI.fs.write(
    WISHLIST_PATH,
    JSON.stringify(entries, null, 2)
  );
  // Guard against error objects and only update store on successful write
  if (result !== 'success') {
    console.error('[wishlist] Failed to write wishlist to disk:', result);
    return false;
  }
  return true;
}

/**
 * Add an entry to the wishlist. Dedupes by (appID, storefront). Updates store only after successful write.
 */
export function addToWishlist(entry: BasicLibraryInfo): void {
  const entries = readWishlistFromDisk();
  if (entries === null) return;
  const exists = entries.some(
    (e) => e.appID === entry.appID && e.storefront === entry.storefront
  );
  if (exists) return;
  const next = [...entries, entry];
  if (saveWishlistSync(next)) {
    wishlist.set(next);
  }
}

/**
 * Remove an entry by (appID, storefront). Updates store only after successful write.
 */
export function removeFromWishlist(appID: number, storefront: string): void {
  const entries = readWishlistFromDisk();
  if (entries === null) return;
  const filtered = entries.filter(
    (e) => !(e.appID === appID && e.storefront === storefront)
  );
  if (saveWishlistSync(filtered)) {
    wishlist.set(filtered);
  }
}

/**
 * Check if (appID, storefront) is in the given list. Use with store: isInWishlist($wishlist, appID, storefront).
 */
export function isInWishlist(
  entries: BasicLibraryInfo[],
  appID: number,
  storefront: string
): boolean {
  return entries.some(
    (e) => e.appID === appID && e.storefront === storefront
  );
}
