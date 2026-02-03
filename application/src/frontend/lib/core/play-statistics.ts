import type { LibraryInfo } from 'ogi-addon';

const RECENTLY_PLAYED_COUNT = 4;
const MOST_PLAYED_COUNT = 8;

/**
 * Load play statistics from the main process.
 *
 * @returns Promise resolving to the current play statistics
 */
export async function getPlayStatistics(): Promise<PlayStatistics> {
  return window.electronAPI.app.getPlayStatistics();
}

/**
 * Get recently played games from library using stats (sort by lastPlayedAt desc, first N).
 *
 * @param library - Full library list to resolve app IDs against
 * @param stats - Play statistics (byAppId with lastPlayedAt)
 * @returns Up to RECENTLY_PLAYED_COUNT library apps, ordered by last played
 */
export function getRecentlyPlayedFromStats(
  library: LibraryInfo[],
  stats: PlayStatistics
): LibraryInfo[] {
  const entries = Object.entries(stats.byAppId)
    .filter(([, e]) => e.lastPlayedAt > 0)
    .sort(([, a], [, b]) => b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, RECENTLY_PLAYED_COUNT);

  const result: LibraryInfo[] = [];
  const byAppId = new Map(library.map((app) => [app.appID, app]));
  for (const [appIDStr] of entries) {
    const appID = Number(appIDStr);
    const app = byAppId.get(appID);
    if (app) result.push(app);
  }
  return result;
}

/**
 * Get most played games from library using stats (sort by totalPlaytimeMs desc, cap at N).
 *
 * @param library - Full library list to resolve app IDs against
 * @param stats - Play statistics (byAppId with totalPlaytimeMs)
 * @returns Up to MOST_PLAYED_COUNT library apps, ordered by total playtime
 */
export function getMostPlayedFromStats(
  library: LibraryInfo[],
  stats: PlayStatistics
): LibraryInfo[] {
  const entries = Object.entries(stats.byAppId)
    .filter(([, e]) => e.totalPlaytimeMs > 0)
    .sort(([, a], [, b]) => b.totalPlaytimeMs - a.totalPlaytimeMs)
    .slice(0, MOST_PLAYED_COUNT);

  const result: LibraryInfo[] = [];
  const byAppId = new Map(library.map((app) => [app.appID, app]));
  for (const [appIDStr] of entries) {
    const appID = Number(appIDStr);
    const app = byAppId.get(appID);
    if (app) result.push(app);
  }
  return result;
}

/**
 * Format playtime in ms to a short string (e.g. "12h 34m" or "45m").
 *
 * @param totalPlaytimeMs - Total playtime in milliseconds
 * @returns Formatted string (e.g. "< 1m", "45m", "12h 34m")
 */
export function formatPlaytime(totalPlaytimeMs: number): string {
  if (totalPlaytimeMs < 60_000) {
    return '< 1m';
  }
  const totalMins = Math.floor(totalPlaytimeMs / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours === 0) {
    return `${mins}m`;
  }
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}
