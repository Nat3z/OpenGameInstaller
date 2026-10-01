import type { LibraryInfo } from '@ogi-sdk/connect';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';

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
