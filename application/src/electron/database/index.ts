import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { app } from 'electron';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { AppDatabase } from './database.js';
import { importLegacyState } from './legacy-import.js';

export { AppDatabase } from './database.js';

export const DATABASE_FILENAME = 'ogi.sqlite';

/** Bundled with the app so a packaged build can migrate on first launch. */
export const migrationsFolder = (): string =>
  join(app.getAppPath(), 'drizzle');

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
