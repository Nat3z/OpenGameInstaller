import type { LibraryInfo } from 'ogi-addon';
import { getRecentlyPlayedFromStats } from './play-statistics';

/**
 * Loads all apps and orders them according to the apps.json file if it exists.
 * Apps are ordered by the order in apps.json, with any new apps appended to the end.
 *
 * @returns A promise that resolves to an ordered array of LibraryInfo
 */
export async function getAllApps(): Promise<LibraryInfo[]> {
  const apps = await window.electronAPI.app.getAllApps();

  if (window.electronAPI.fs.exists('./internals/apps.json')) {
    const appsOrdered: number[] = JSON.parse(
      window.electronAPI.fs.read('./internals/apps.json')
    );

    // Map ordered IDs to apps, filtering out undefined values
    let library = appsOrdered
      .map((id) => apps.find((app) => app.appID === id))
      .filter((app): app is LibraryInfo => app !== undefined);

    // Remove duplicate apps (keep first occurrence)
    library = library.filter(
      (app, index) =>
        library.findIndex((libApp) => libApp.appID === app.appID) === index
    );

    // Add any apps that aren't in the ordered list
    apps.forEach((app) => {
      if (!library.find((libApp) => libApp.appID === app.appID)) {
        console.log('Adding app to library: ' + app.name);
        library.push(app);
      }
    });

    return library;
  } else {
    return apps;
  }
}

/**
 * Gets the recently played apps from the library.
 * When stats are provided, sorts by lastPlayedAt (first 4). Otherwise uses apps.json order.
 *
 * @param library - The library array to get recently played apps from
 * @param stats - Optional play statistics; when provided, recently played is derived from lastPlayedAt
 * @returns An array of LibraryInfo representing recently played apps (max 4)
 */
export function getRecentlyPlayed(
  library: LibraryInfo[],
  stats?: PlayStatistics
): LibraryInfo[] {
  if (stats && Object.keys(stats.byAppId).length > 0) {
    return getRecentlyPlayedFromStats(library, stats);
  }
  if (window.electronAPI.fs.exists('./internals/apps.json')) {
    const appsOrdered: number[] = JSON.parse(
      window.electronAPI.fs.read('./internals/apps.json')
    );

    const recentlyPlayed: LibraryInfo[] = [];
    let itemsAdded = 0;

    appsOrdered.forEach((appID) => {
      if (itemsAdded >= 4) return;
      const app = library.find((libApp) => libApp.appID === appID);
      if (app) {
        recentlyPlayed.push(app);
        itemsAdded++;
      }
    });

    return recentlyPlayed;
  }
  return [];
}

/**
 * Loads a single app from the library by app ID (reads library/{appID}.json).
 *
 * @param appID - The app ID to load
 * @returns The LibraryInfo if the file exists, otherwise undefined
 */
export function getApp(appID: number): LibraryInfo | undefined {
  if (window.electronAPI.fs.exists(`./library/${appID}.json`)) {
    return JSON.parse(window.electronAPI.fs.read(`./library/${appID}.json`));
  } else {
    return undefined;
  }
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
  return [...library].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
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
  if (searchQuery.trim() === '') {
    return library;
  } else {
    return library.filter((app) =>
      app.name.toLowerCase().includes(searchQuery.toLowerCase())
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
