/**
 * Library persistence. A thin layer over the SQLite database so callers keep
 * working with plain `LibraryInfo` values.
 */

import type { LibraryInfo } from '@ogi-sdk/connect';
import { GameNotFound } from '@ogi-sdk/errors';
import { getDatabase } from '@/electron/database/index.js';

export function loadLibraryInfo(appID: number): LibraryInfo | null {
  return getDatabase().getGame(appID);
}

export function loadLibraryInfoOrThrow(appID: number): LibraryInfo {
  const appInfo = loadLibraryInfo(appID);
  if (!appInfo) {
    throw new GameNotFound({ gameId: appID });
  }
  return appInfo;
}

export function saveLibraryInfo(appID: number, data: LibraryInfo): void {
  getDatabase().saveGame({ ...data, appID });
}

/** Most recently launched first. */
export function getAllLibraryEntries(): LibraryInfo[] {
  return getDatabase().listGames();
}

export type LibraryRemovalTransaction = {
  commit: () => void;
  rollback: () => void;
};

/** Hides the game until `commit`; throws when it is not in the library. */
export function stageLibraryRemoval(appID: number): LibraryRemovalTransaction {
  return getDatabase().stageGameRemoval(appID);
}
