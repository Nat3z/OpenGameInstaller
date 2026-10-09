import type { LibraryInfo } from '@ogi-sdk/connect';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import type { FoundGame } from '@/lib/electron-rpc.js';

/** Loads the library, most recently launched first. */
export function getAllApps(): Promise<LibraryInfo[]> {
  return runFrontendEffect(electronRpc.app.getAllApps());
}

/** The first games of a recency-ordered library, at most `limit`. */
export function getRecentlyPlayed(
  library: LibraryInfo[],
  limit = 4
): LibraryInfo[] {
  return library.slice(0, limit);
}

export function getApp(appID: number): Promise<LibraryInfo | null> {
  return runFrontendEffect(electronRpc.app.getLibraryInfo(appID));
}

/**
 * Sorts a library array alphabetically by game name.
 *
 * @param library - The library array to sort
 * @returns A new sorted array of LibraryInfo
 */
export function sortLibraryAlphabetically(
  library: LibraryInfo[]
): LibraryInfo[] {
  const collator = new Intl.Collator(undefined, {
    sensitivity: 'base',
    numeric: true,
    ignorePunctuation: true,
  });

  return [...library].sort((a, b) =>
    collator.compare(a.name.trim(), b.name.trim())
  );
}

/**
 * Filters a library array based on a search query.
 * Returns all games if search query is empty, otherwise filters by name.
 *
 * @param library - The library array to filter
 * @param searchQuery - The search query string
 * @returns A filtered array of LibraryInfo
 */
export function filterLibrary(
  library: LibraryInfo[],
  searchQuery: string
): LibraryInfo[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  if (normalizedQuery === '') {
    return sortLibraryAlphabetically(library);
  } else {
    return sortLibraryAlphabetically(
      library.filter((app) => app.name.toLowerCase().includes(normalizedQuery))
    );
  }
}

/**
 * Splits an array into chunks of a specified size.
 *
 * @param array - The array to chunk
 * @param size - The size of each chunk
 * @returns An array of arrays containing the chunks
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Missing games the user chose to keep; not prompted again this session.
const keptMissingGames = new Set<number>();

/**
 * Finds library entries whose install folder no longer exists on disk, e.g.
 * deleted outside the app or on a drive that isn't connected. Games kept via
 * `keepMissingGames` are skipped.
 *
 * @returns The games whose `cwd` is set but missing
 */
export async function findMissingGames(): Promise<LibraryInfo[]> {
  const missing = await runFrontendEffect(electronRpc.app.getMissingApps());
  return missing.filter((app) => !keptMissingGames.has(app.appID));
}

export function keepMissingGames(appIDs: number[]): void {
  for (const appID of appIDs) keptMissingGames.add(appID);
}

// Found game folders the user chose to skip; not prompted again this session.
const skippedFoundGames = new Set<string>();

/**
 * Finds game folders on disk (download locations, other games' folders,
 * removable media, and `folder` when given) whose games are not in the
 * library or were moved there from a now-missing folder. Skipped folders are
 * left out unless `folder` was picked by hand.
 */
export async function findGamesOnDisk(folder?: string): Promise<FoundGame[]> {
  const found = await runFrontendEffect(
    electronRpc.app.findGamesOnDisk(folder)
  );
  return folder ? found : found.filter((g) => !skippedFoundGames.has(g.path));
}

export function skipFoundGames(paths: string[]): void {
  for (const path of paths) skippedFoundGames.add(path);
}
