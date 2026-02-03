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
 * Load wishlist from disk and sync the store. Returns entries; empty array if missing/invalid.
 */
export async function loadWishlist(): Promise<BasicLibraryInfo[]> {
  ensureInternals();
  if (!window.electronAPI.fs.exists(WISHLIST_PATH)) {
    wishlist.set([]);
    return [];
  }
  const raw = window.electronAPI.fs.read(WISHLIST_PATH);
  if (typeof raw !== 'string') {
    wishlist.set([]);
    return [];
  }
  const entries = parseWishlistJson(raw);
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
  return result === 'success';
}

/**
 * Add an entry to the wishlist. Dedupes by (appID, storefront). Updates store only after successful write.
 */
export function addToWishlist(entry: BasicLibraryInfo): void {
  const raw = window.electronAPI.fs.exists(WISHLIST_PATH)
    ? window.electronAPI.fs.read(WISHLIST_PATH)
    : '[]';
  if (typeof raw !== 'string') return;
  const entries = parseWishlistJson(raw);
  const exists = entries.some(
    (e) => e.appID === entry.appID && e.storefront === entry.storefront
  );
  if (exists) return;
  const next = [...entries, entry];
  if (saveWishlistSync(next)) wishlist.set(next);
}

/**
 * Remove an entry by (appID, storefront). Updates store only after successful write.
 */
export function removeFromWishlist(appID: number, storefront: string): void {
  const raw = window.electronAPI.fs.exists(WISHLIST_PATH)
    ? window.electronAPI.fs.read(WISHLIST_PATH)
    : '[]';
  if (typeof raw !== 'string') return;
  const entries = parseWishlistJson(raw).filter(
    (e) => !(e.appID === appID && e.storefront === storefront)
  );
  if (saveWishlistSync(entries)) wishlist.set(entries);
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
