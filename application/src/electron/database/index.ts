import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { app } from 'electron';
import { isUnsafeDownloadLocation } from '@/electron/lib/delete-guards.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { AppDatabase } from './database.js';
import { importLegacyState } from './legacy-import.js';

export { AppDatabase, type LibraryRemoval } from './database.js';

export const DATABASE_FILENAME = 'ogi.sqlite';

const logger = createLogger(LOGGER_PREFIXES.electron);

/** Bundled with the app so a packaged build can migrate on first launch. */
export const migrationsFolder = (): string => join(app.getAppPath(), 'drizzle');

let database: AppDatabase | undefined;

// Loaded on first open rather than at import so test runners without the
// Electron-built native module can still import this module and inject a
// bun:sqlite-backed database through `setDatabase`.
const loadDriver = (): typeof BetterSqlite3 =>
  createRequire(import.meta.url)('better-sqlite3');

export function openDatabase(
  directory: string = __dirname,
  migrations: string = migrationsFolder()
): AppDatabase {
  mkdirSync(directory, { recursive: true });
  const Database = loadDriver();
  const client = new Database(join(directory, DATABASE_FILENAME));
  client.pragma('journal_mode = WAL');
  client.pragma('synchronous = NORMAL');
  client.pragma('busy_timeout = 5000');
  const opened = new AppDatabase(drizzle(client), migrations);
  importLegacyState(directory, opened);
  // The renderer used to resolve `./downloads` against the data dir; pin it so
  // every process agrees and path guards can require absolute paths. A
  // location broad enough to cover home or app data (only reachable through
  // older versions) falls back to the default folder.
  const { fileDownloadLocation } = opened.getSettings();
  const pinned = resolve(directory, fileDownloadLocation);
  if (isUnsafeDownloadLocation(pinned, directory)) {
    logger.sync.warn(
      `[database] Download location ${pinned} is too broad; using the default`
    );
    opened.updateSettings({
      fileDownloadLocation: resolve(directory, 'downloads'),
    });
  } else if (!isAbsolute(fileDownloadLocation)) {
    opened.updateSettings({ fileDownloadLocation: pinned });
  }
  return opened;
}

/** The process-wide database, opened on first use. */
export function getDatabase(): AppDatabase {
  database ??= openDatabase();
  return database;
}

/** Test seam: replaces the process-wide database. */
export function setDatabase(next: AppDatabase | undefined): void {
  database = next;
}

export function closeDatabase(): void {
  database?.close();
  database = undefined;
}

export const databaseExists = (directory: string = __dirname): boolean =>
  existsSync(join(directory, DATABASE_FILENAME));
