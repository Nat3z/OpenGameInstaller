/**
 * Library file operations
 */

import type { LibraryInfo } from '@ogi-sdk/connect';
import { GameNotFound } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import * as fs from 'fs';
import { dirname, join } from 'path';
import { __dirname } from '@/electron/manager/manager.paths.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

export function getLibraryPath(appID: number): string {
  return join(__dirname, `library/${appID}.json`);
}

const writeJsonAtomic = (filePath: string, value: unknown): void => {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.ogi-${process.pid}-${Date.now()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'w');
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
};

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
    throw new GameNotFound({ gameId: appID });
  }
  return appInfo;
}

export function saveLibraryInfo(appID: number, data: LibraryInfo): void {
  writeJsonAtomic(getLibraryPath(appID), data);
}

const activeLibraryRemovalTombstones = new Set<string>();

const recoverLibraryTransactions = (libraryDir: string): void => {
  for (const file of fs.readdirSync(libraryDir)) {
    const removing = file.match(/^(\d+\.json)\.ogi-removing-(\d+)-\d+$/);
    if (removing) {
      const tombstonePath = join(libraryDir, file);
      if (activeLibraryRemovalTombstones.has(tombstonePath)) continue;
      const appPath = join(libraryDir, removing[1]);
      const appID = Number.parseInt(removing[1], 10);
      if (fs.existsSync(appPath)) {
        fs.rmSync(tombstonePath, { force: true });
      } else {
        fs.renameSync(tombstonePath, appPath);
        addToInternalsApps(appID);
      }
      continue;
    }
    if (/^\d+\.json\.ogi-deleted-\d+-\d+$/.test(file)) {
      fs.rmSync(join(libraryDir, file), { force: true });
    }
  }
};

export function ensureLibraryDir(): void {
  const libraryDir = join(__dirname, 'library');
  if (!fs.existsSync(libraryDir)) {
    fs.mkdirSync(libraryDir, { recursive: true });
  }
  recoverLibraryTransactions(libraryDir);
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
  recoverLibraryTransactions(libraryDir);
  const files = fs
    .readdirSync(libraryDir)
    .filter((file) => /^\d+\.json$/.test(file));
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

export type LibraryRemovalTransaction = {
  commit: () => void;
  rollback: () => void;
};

export function stageLibraryRemoval(appID: number): LibraryRemovalTransaction {
  const appPath = getLibraryPath(appID);
  const transactionId = `${process.pid}-${Date.now()}`;
  const tombstonePath = `${appPath}.ogi-removing-${transactionId}`;
  const deletedPath = `${appPath}.ogi-deleted-${transactionId}`;
  const originalApps = loadInternalsApps();
  fs.renameSync(appPath, tombstonePath);
  activeLibraryRemovalTombstones.add(tombstonePath);
  try {
    saveInternalsApps(originalApps.filter((candidate) => candidate !== appID));
  } catch (cause) {
    activeLibraryRemovalTombstones.delete(tombstonePath);
    fs.renameSync(tombstonePath, appPath);
    throw cause;
  }

  let settled = false;
  return {
    commit: () => {
      if (settled) return;
      let cleanupPath = tombstonePath;
      try {
        fs.renameSync(tombstonePath, deletedPath);
        cleanupPath = deletedPath;
      } catch (cause) {
        logger.sync.warn('[library] Could not mark deletion tombstone', cause);
      }
      settled = true;
      activeLibraryRemovalTombstones.delete(tombstonePath);
      try {
        fs.rmSync(cleanupPath, { force: true });
      } catch (cause) {
        logger.sync.warn(
          '[library] Could not remove deletion tombstone',
          cause
        );
      }
    },
    rollback: () => {
      if (settled) return;
      fs.renameSync(tombstonePath, appPath);
      try {
        addToInternalsApps(appID);
      } catch (cause) {
        fs.renameSync(appPath, tombstonePath);
        throw cause;
      }
      activeLibraryRemovalTombstones.delete(tombstonePath);
      settled = true;
    },
  };
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
  writeJsonAtomic(getInternalsAppsPath(), appIDs);
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
