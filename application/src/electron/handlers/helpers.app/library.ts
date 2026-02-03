/**
 * Library file operations
 */
import { join, resolve, relative, sep } from 'path';
import * as fs from 'fs';
import { LibraryInfo } from 'ogi-addon';
import { __dirname } from '../../manager/manager.paths.js';

/**
 * Resolves game cwd to an absolute path (relative paths resolved against appDataDir).
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

export function getLibraryPath(appID: number): string {
  return join(__dirname, `library/${appID}.json`);
}

export function loadLibraryInfo(appID: number): LibraryInfo | null {
  const appPath = getLibraryPath(appID);
  if (!fs.existsSync(appPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(appPath, 'utf-8'));
}

export function loadLibraryInfoOrThrow(appID: number): LibraryInfo {
  const appInfo = loadLibraryInfo(appID);
  if (!appInfo) {
    throw new Error(`Game not found: ${appID}`);
  }
  return appInfo;
}

export function saveLibraryInfo(appID: number, data: LibraryInfo): void {
  const appPath = getLibraryPath(appID);
  fs.writeFileSync(appPath, JSON.stringify(data, null, 2));
}

export function ensureLibraryDir(): void {
  const libraryDir = join(__dirname, 'library');
  if (!fs.existsSync(libraryDir)) {
    fs.mkdirSync(libraryDir, { recursive: true });
  }
}

export function ensureInternalsDir(): void {
  const internalsDir = join(__dirname, 'internals');
  if (!fs.existsSync(internalsDir)) {
    fs.mkdirSync(internalsDir, { recursive: true });
  }
}

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

export function removeLibraryFile(appID: number): void {
  const appPath = getLibraryPath(appID);
  if (fs.existsSync(appPath)) {
    fs.unlinkSync(appPath);
  }
}

export function getInternalsAppsPath(): string {
  return join(__dirname, 'internals/apps.json');
}

export function loadInternalsApps(): number[] {
  const appsPath = getInternalsAppsPath();
  if (!fs.existsSync(appsPath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(appsPath, 'utf-8'));
}

export function saveInternalsApps(appIDs: number[]): void {
  ensureInternalsDir();
  const appsPath = getInternalsAppsPath();
  fs.writeFileSync(appsPath, JSON.stringify(appIDs, null, 2));
}

export function addToInternalsApps(appID: number): void {
  const apps = loadInternalsApps();
  if (!apps.includes(appID)) {
    apps.push(appID);
    saveInternalsApps(apps);
  }
}

export function removeFromInternalsApps(appID: number): void {
  const apps = loadInternalsApps();
  const index = apps.indexOf(appID);
  if (index > -1) {
    apps.splice(index, 1);
    saveInternalsApps(apps);
  }
}
