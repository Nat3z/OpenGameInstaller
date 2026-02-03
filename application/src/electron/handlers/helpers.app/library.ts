/**
 * Library file operations
 */
import { join, resolve, relative, sep } from 'path';
import * as fs from 'fs';
import { LibraryInfo } from 'ogi-addon';
import { __dirname } from '../../manager/manager.paths.js';

/**
 * Resolves game cwd to an absolute path (relative paths resolved against appDataDir).
 *
 * @param cwd - Game working directory (absolute or relative)
 * @param appDataDir - Application data directory used as base for relative cwd
 * @returns Absolute path to the game directory
 */
export function resolveGameCwd(cwd: string, appDataDir: string): string {
  if (cwd.startsWith('/') || (cwd.length >= 2 && cwd[1] === ':')) {
    return resolve(cwd);
  }
  return resolve(appDataDir, cwd);
}

/**
 * Returns true if the resolved game path is safe to delete (must be strictly under
 * appDataDir to avoid deleting system, home root, or the app data directory itself).
 *
 * @param cwd - Game working directory (absolute or relative)
 * @param appDataDir - Application data directory; path must be strictly under this
 * @returns true if the path is safe to delete, false otherwise
 */
export function isSafeToDeleteGamePath(
  cwd: string,
  appDataDir: string
): boolean {
  const resolved = resolve(resolveGameCwd(cwd, appDataDir));
  const root = resolve(appDataDir);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || rel === '' || rel === '.') {
    return false;
  }
  return resolved.startsWith(root + sep);
}

/**
 * Returns the filesystem path to the library JSON file for a given app ID.
 *
 * @param appID - The application/game ID
 * @returns Absolute path to library/{appID}.json
 */
export function getLibraryPath(appID: number): string {
  return join(__dirname, `library/${appID}.json`);
}

/**
 * Loads library metadata for an app from disk, or null if the file does not exist.
 *
 * @param appID - The application/game ID
 * @returns Parsed LibraryInfo or null
 */
export function loadLibraryInfo(appID: number): LibraryInfo | null {
  const appPath = getLibraryPath(appID);
  if (!fs.existsSync(appPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(appPath, 'utf-8'));
}

/**
 * Loads library metadata for an app or throws if the file does not exist.
 *
 * @param appID - The application/game ID
 * @returns Parsed LibraryInfo
 * @throws Error if the game is not found
 */
export function loadLibraryInfoOrThrow(appID: number): LibraryInfo {
  const appInfo = loadLibraryInfo(appID);
  if (!appInfo) {
    throw new Error(`Game not found: ${appID}`);
  }
  return appInfo;
}

/**
 * Writes library metadata for an app to disk.
 *
 * @param appID - The application/game ID
 * @param data - LibraryInfo to persist
 */
export function saveLibraryInfo(appID: number, data: LibraryInfo): void {
  const appPath = getLibraryPath(appID);
  fs.writeFileSync(appPath, JSON.stringify(data, null, 2));
}

/**
 * Creates the library directory if it does not exist.
 */
export function ensureLibraryDir(): void {
  const libraryDir = join(__dirname, 'library');
  if (!fs.existsSync(libraryDir)) {
    fs.mkdirSync(libraryDir, { recursive: true });
  }
}

/**
 * Creates the internals directory if it does not exist.
 */
export function ensureInternalsDir(): void {
  const internalsDir = join(__dirname, 'internals');
  if (!fs.existsSync(internalsDir)) {
    fs.mkdirSync(internalsDir, { recursive: true });
  }
}

/**
 * Reads all library JSON files and returns their parsed contents.
 *
 * @returns Array of LibraryInfo; empty if the library directory does not exist
 */
export function getAllLibraryFiles(): LibraryInfo[] {
  const libraryDir = join(__dirname, 'library');
  if (!fs.existsSync(libraryDir)) {
    return [];
  }
  const files = fs.readdirSync(libraryDir);
  const apps: LibraryInfo[] = [];
  for (const file of files) {
    const data = fs.readFileSync(join(libraryDir, file), 'utf-8');
    apps.push(JSON.parse(data));
  }
  return apps;
}

/**
 * Deletes the library JSON file for an app if it exists.
 *
 * @param appID - The application/game ID
 */
export function removeLibraryFile(appID: number): void {
  const appPath = getLibraryPath(appID);
  if (fs.existsSync(appPath)) {
    fs.unlinkSync(appPath);
  }
}

/**
 * Returns the filesystem path to the internals apps list (apps.json).
 *
 * @returns Absolute path to internals/apps.json
 */
export function getInternalsAppsPath(): string {
  return join(__dirname, 'internals/apps.json');
}

/**
 * Loads the list of app IDs stored in internals (e.g. for Steam integration).
 *
 * @returns Array of app IDs; empty array if the file does not exist
 */
export function loadInternalsApps(): number[] {
  const appsPath = getInternalsAppsPath();
  if (!fs.existsSync(appsPath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(appsPath, 'utf-8'));
}

/**
 * Persists the list of app IDs to internals/apps.json.
 *
 * @param appIDs - Array of app IDs to save
 */
export function saveInternalsApps(appIDs: number[]): void {
  ensureInternalsDir();
  const appsPath = getInternalsAppsPath();
  fs.writeFileSync(appsPath, JSON.stringify(appIDs, null, 2));
}

/**
 * Appends an app ID to the internals list if not already present.
 *
 * @param appID - The application/game ID to add
 */
export function addToInternalsApps(appID: number): void {
  const apps = loadInternalsApps();
  if (!apps.includes(appID)) {
    apps.push(appID);
    saveInternalsApps(apps);
  }
}

/**
 * Removes an app ID from the internals list if present.
 *
 * @param appID - The application/game ID to remove
 */
export function removeFromInternalsApps(appID: number): void {
  const apps = loadInternalsApps();
  const index = apps.indexOf(appID);
  if (index > -1) {
    apps.splice(index, 1);
    saveInternalsApps(apps);
  }
}
