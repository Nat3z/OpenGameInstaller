import { exec } from 'child_process';
import { __dirname } from './manager/manager.paths.js';
import { join } from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import {
  existsSync,
  readdirSync,
  statSync,
  copyFileSync,
  mkdirSync,
  rmSync,
} from 'original-fs';
import type { LibraryInfo } from 'ogi-addon';
import { app, BrowserWindow } from 'electron';
import { sendNotification } from './main.js';
import semver from 'semver';
import { setupAddon } from './manager/manager.addon.js';

const UMU_RELEASES_URL =
  'https://api.github.com/repos/Open-Wine-Components/umu-launcher/releases/latest';
const UMU_BIN_DIR = join(__dirname, 'bin', 'umu');
const UMU_RUN_EXECUTABLE = join(UMU_BIN_DIR, 'umu-run');
const UMU_TARBALL_PATH = join(UMU_BIN_DIR, 'umu-launcher-zipapp.tar');
const UMU_VERSION_FILE = join(UMU_BIN_DIR, '.version');
const UMU_LAST_CHECK_FILE = join(UMU_BIN_DIR, '.last-check');
const UMU_BACKGROUND_CHECK_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

let umuBackgroundCheckTimeout: NodeJS.Timeout | null = null;
let umuBackgroundCheckInterval: NodeJS.Timeout | null = null;
let umuBackgroundCheckInProgress = false;

type UmuReleaseResponse = {
  tag_name?: string;
  assets?: Array<{ name: string; browser_download_url: string }>;
};

type DownloadLatestUmuResult = {
  success: boolean;
  updated: boolean;
  currentVersion?: string;
  latestVersion?: string;
  error?: string;
};

function quoteForShell(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function parseVersionFromText(text: string): string | null {
  const match = text.match(/v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0] ?? null;
}

async function execAsync(
  command: string,
  options?: { maxBuffer?: number; timeout?: number }
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    exec(
      command,
      {
        maxBuffer: options?.maxBuffer,
        timeout: options?.timeout,
      },
      (error, stdout, stderr) => {
        if (error) {
          const execErr = error as NodeJS.ErrnoException & { killed?: boolean };
          if (options?.timeout && execErr.killed) {
            reject(
              new Error(
                `Command timed out after ${options.timeout}ms: ${command}`
              )
            );
            return;
          }
          if (options?.maxBuffer && execErr.code === 'ENOBUFS') {
            reject(
              new Error(
                `Command output exceeded maxBuffer (${options.maxBuffer} bytes): ${command}`
              )
            );
            return;
          }
          reject(error);
          return;
        }
        resolve(`${stdout}\n${stderr}`.trim());
      }
    );
  });
}

async function readInstalledUmuVersion(): Promise<string | null> {
  if (fs.existsSync(UMU_VERSION_FILE)) {
    const savedVersion = fs.readFileSync(UMU_VERSION_FILE, 'utf-8').trim();
    if (savedVersion) {
      return savedVersion;
    }
  }

  if (!fs.existsSync(UMU_RUN_EXECUTABLE)) {
    return null;
  }

  const versionCommands = ['--version', '-V'];
  for (const flag of versionCommands) {
    try {
      const output = await execAsync(
        `${quoteForShell(UMU_RUN_EXECUTABLE)} ${flag}`
      );
      const version = parseVersionFromText(output);
      if (version) {
        return version;
      }
    } catch {
      // Try the next flag.
    }
  }

  return null;
}

async function extractUmuTarball(tarballPath: string): Promise<void> {
  await execAsync(
    `tar -xvf ${quoteForShell(tarballPath)} -C ${quoteForShell(UMU_BIN_DIR)}`
  );

  const extractedEntries = fs.readdirSync(UMU_BIN_DIR, { withFileTypes: true });
  const extractedDirectories = extractedEntries.filter((entry) =>
    entry.isDirectory()
  );
  const nestedRootWithBinary = extractedDirectories.find((entry) =>
    fs.existsSync(join(UMU_BIN_DIR, entry.name, 'umu-run'))
  );
  const nestedRoot = nestedRootWithBinary
    ? join(UMU_BIN_DIR, nestedRootWithBinary.name)
    : extractedDirectories.length === 1
      ? join(UMU_BIN_DIR, extractedDirectories[0].name)
      : null;

  // Match current behavior: some archives contain one nested top-level directory.
  if (nestedRoot) {
    const nestedEntries = fs.readdirSync(nestedRoot, { withFileTypes: true });

    for (const entry of nestedEntries) {
      const src = join(nestedRoot, entry.name);
      const dest = join(UMU_BIN_DIR, entry.name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(src, dest);
    }

    fs.rmSync(nestedRoot, { recursive: true, force: true });
  }
}

function readUmuLastCheckTimestamp(): number | null {
  if (!fs.existsSync(UMU_LAST_CHECK_FILE)) {
    return null;
  }

  try {
    const rawValue = fs.readFileSync(UMU_LAST_CHECK_FILE, 'utf-8').trim();
    if (!rawValue) return null;
    const parsedValue = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) return null;
    return parsedValue;
  } catch {
    return null;
  }
}

function writeUmuLastCheckTimestamp(timestamp = Date.now()): void {
  try {
    if (!fs.existsSync(UMU_BIN_DIR)) {
      fs.mkdirSync(UMU_BIN_DIR, { recursive: true });
    }
    fs.writeFileSync(UMU_LAST_CHECK_FILE, `${timestamp}\n`);
  } catch (error) {
    console.warn('[umu] Failed to persist last background check timestamp', {
      error,
    });
  }
}

function getUmuDelayUntilNextCheck(): number {
  const now = Date.now();
  const lastCheck = readUmuLastCheckTimestamp();
  if (!lastCheck) return 0;

  const elapsed = now - lastCheck;
  if (elapsed >= UMU_BACKGROUND_CHECK_INTERVAL_MS) {
    return 0;
  }

  return UMU_BACKGROUND_CHECK_INTERVAL_MS - elapsed;
}

async function runUmuBackgroundCheck(reason: 'startup' | 'scheduled') {
  if (umuBackgroundCheckInProgress) {
    console.log('[umu] Background check already in progress, skipping trigger');
    return;
  }

  umuBackgroundCheckInProgress = true;
  try {
    console.log(`[umu] Running background UMU update check (${reason})`);
    const result = await downloadLatestUmu();
    if (!result.success) {
      console.warn('[umu] Background UMU update check failed:', result.error);
      return;
    }

    if (result.updated) {
      console.log(
        `[umu] Background update applied (${result.currentVersion ?? 'none'} -> ${result.latestVersion ?? 'unknown'})`
      );
      return;
    }

    console.log(
      `[umu] Background check complete: already up to date (${result.latestVersion ?? result.currentVersion ?? 'unknown'})`
    );
  } finally {
    writeUmuLastCheckTimestamp();
    umuBackgroundCheckInProgress = false;
  }
}

function startUmuRecurringInterval() {
  if (umuBackgroundCheckInterval) {
    return;
  }

  umuBackgroundCheckInterval = setInterval(() => {
    void runUmuBackgroundCheck('scheduled');
  }, UMU_BACKGROUND_CHECK_INTERVAL_MS);
  umuBackgroundCheckInterval.unref?.();
}

export function startUmuBackgroundUpdater() {
  if (process.platform !== 'linux') {
    return;
  }

  if (umuBackgroundCheckTimeout || umuBackgroundCheckInterval) {
    return;
  }

  const delayMs = getUmuDelayUntilNextCheck();
  if (delayMs === 0) {
    void runUmuBackgroundCheck('startup');
    startUmuRecurringInterval();
    console.log('[umu] Background updater started (3 day cadence)');
    return;
  }

  umuBackgroundCheckTimeout = setTimeout(() => {
    umuBackgroundCheckTimeout = null;
    void runUmuBackgroundCheck('startup');
    startUmuRecurringInterval();
  }, delayMs);
  umuBackgroundCheckTimeout.unref?.();

  console.log(
    `[umu] Background updater scheduled to run in ${Math.ceil(
      delayMs / (1000 * 60)
    )} minute(s), then every 3 days`
  );
}

export function stopUmuBackgroundUpdater() {
  if (umuBackgroundCheckTimeout) {
    clearTimeout(umuBackgroundCheckTimeout);
    umuBackgroundCheckTimeout = null;
  }

  if (umuBackgroundCheckInterval) {
    clearInterval(umuBackgroundCheckInterval);
    umuBackgroundCheckInterval = null;
  }
}

// check if NixOS using command -v nixos-rebuild
export const IS_NIXOS = await (() => {
  return new Promise<boolean>((resolve) => {
    try {
      exec('command -v nixos-rebuild', (error, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          resolve(false);
          return;
        }
        if (stderr.includes('nixos-rebuild')) {
          resolve(true);
          return;
        }
        resolve(false);
      });
    } catch (error) {
      console.error(`exec error: ${error}`);
      resolve(false);
    }
  });
})();
console.log('continuing launch...');
export let STEAMTINKERLAUNCH_PATH = join(
  __dirname,
  'bin/steamtinkerlaunch/steamtinkerlaunch'
);
async function fetch_STLPath() {
  return new Promise<void>((resolve) => {
    exec('which steamtinkerlaunch', (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        resolve();
        return;
      }
      if (stderr) {
        console.error(`stderr: ${stderr}`);
        resolve();
        return;
      }

      // The path will be returned as a string in stdout.
      const path = stdout.trim(); // Remove any extra newlines or spaces.
      STEAMTINKERLAUNCH_PATH = path;
      resolve();
    });
  });
}
console.log('NIXOS: ' + IS_NIXOS);
if (IS_NIXOS) await fetch_STLPath();
if (STEAMTINKERLAUNCH_PATH === '') {
  STEAMTINKERLAUNCH_PATH = join(
    __dirname,
    'bin/steamtinkerlaunch/steamtinkerlaunch'
  );
  console.error(
    'STEAMTINKERLAUNCH_PATH is empty. Using default path to prevent issues.'
  );
}

// Directories to skip during restore (same as backup - node_modules will be reinstalled)
const dirsToSkipRestore = ['node_modules'];

/**
 * Counts the total number of files to restore, excluding specified directories.
 */
function countFilesToRestore(sourcePath: string): number {
  if (!existsSync(sourcePath)) return 0;

  try {
    const stat = statSync(sourcePath);
    if (!stat.isDirectory()) return 1;
  } catch {
    // Skip this path on transient I/O/permission errors
    return 0;
  }

  let count = 0;
  try {
    const entries = readdirSync(sourcePath);
    for (const entry of entries) {
      if (dirsToSkipRestore.includes(entry)) continue;
      const fullPath = join(sourcePath, entry);
      count += countFilesToRestore(fullPath);
    }
  } catch {
    // Ignore permission errors
  }
  return count;
}

/**
 * Recursively copies a directory while skipping specified directories (like node_modules).
 * Yields progress after each file copy.
 */
async function* copyDirectoryAsyncRestore(
  source: string,
  destination: string
): AsyncGenerator<{ file: string; success: boolean; error?: string }> {
  if (!existsSync(source)) return;

  let stat;
  try {
    stat = statSync(source);
  } catch (err: any) {
    console.error(`[backup] Failed to stat ${source}: ${err.message}`);
    yield { file: source, success: false, error: err.message };
    return;
  }
  if (!stat.isDirectory()) {
    // It's a file, copy it
    try {
      copyFileSync(source, destination);
      yield { file: source, success: true };
    } catch (error: any) {
      console.error(`[backup] Failed to copy ${source}: ${error.message}`);
      yield { file: source, success: false, error: error.message };
    }
    return;
  }

  // It's a directory
  try {
    if (!existsSync(destination)) {
      mkdirSync(destination, { recursive: true });
    }

    const entries = readdirSync(source);
    for (const entry of entries) {
      if (dirsToSkipRestore.includes(entry)) {
        console.log(`[backup] Skipping ${entry} (will be reinstalled)`);
        continue;
      }

      const srcPath = join(source, entry);
      const destPath = join(destination, entry);

      // Recursively yield from subdirectories/files
      yield* copyDirectoryAsyncRestore(srcPath, destPath);
    }
  } catch (error: any) {
    console.error(
      `[backup] Failed to read directory ${source}: ${error.message}`
    );
    yield { file: source, success: false, error: error.message };
  }
}

export async function restoreBackup(
  onProgress?: (file: string, current: number, total: number) => void
): Promise<{ needsAddonReinstall: boolean }> {
  let needsAddonReinstall = false;
  const backupDir = join(app.getPath('temp'), 'ogi-update-backup');

  // Check if backup directory exists
  if (!existsSync(backupDir)) {
    return { needsAddonReinstall: false };
  }

  // Check for addon reinstall flag (works for both Windows and Linux)
  const flagPath = join(backupDir, 'needs-addon-reinstall.flag');
  if (existsSync(flagPath)) {
    needsAddonReinstall = true;
    console.log('[backup] Addon reinstall flag found');
    try {
      fs.unlinkSync(flagPath);
    } catch {
      // Ignore - will be deleted with the directory
    }
  }

  // Restore the backup asynchronously
  console.log('[backup] Restoring backup...');
  try {
    // Get list of files/directories to restore
    const filesToRestore = readdirSync(backupDir).filter(
      (file) => file !== 'needs-addon-reinstall.flag'
    );

    if (filesToRestore.length === 0) {
      console.log('[backup] No files to restore');
      // Clean up empty backup directory
      try {
        rmSync(backupDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      return { needsAddonReinstall };
    }

    // Count total files to restore for progress tracking
    let totalFiles = 0;
    for (const file of filesToRestore) {
      const source = join(backupDir, file);
      totalFiles += countFilesToRestore(source);
    }

    console.log(`[backup] Total files to restore: ${totalFiles}`);

    let restoredFiles = 0;
    let failedFiles: string[] = [];

    // Restore each file/directory
    for (const file of filesToRestore) {
      const source = join(backupDir, file);
      const destination = join(__dirname, file);

      if (!existsSync(source)) {
        console.log(`[backup] Skipping ${file} (does not exist)`);
        continue;
      }

      console.log(`[backup] Restoring ${file}`);

      // Copy files asynchronously with progress
      for await (const result of copyDirectoryAsyncRestore(
        source,
        destination
      )) {
        restoredFiles++;

        // Update progress periodically (every 10 files or so to avoid UI spam)
        if (restoredFiles % 10 === 0 || restoredFiles === totalFiles) {
          onProgress?.(file, restoredFiles, totalFiles);
        }

        if (!result.success) {
          failedFiles.push(result.file);
        }

        // Yield to event loop to prevent UI freezing
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (failedFiles.length > 0) {
      console.warn(
        `[backup] Failed to restore ${failedFiles.length} files:`,
        failedFiles.slice(0, 10)
      );
    }

    // Remove the backup directory
    // On Windows, files may still be locked after copying, so we need to handle permission errors
    try {
      rmSync(backupDir, { recursive: true, force: true });
      console.log('[backup] Backup restored successfully!');
    } catch (deleteError: any) {
      // If deletion fails due to permissions (common on Windows), log a warning but don't fail
      if (deleteError.code === 'EPERM' || deleteError.code === 'EBUSY') {
        console.warn(
          '[backup] Could not delete backup directory immediately (files may be locked). Backup will be cleaned up on next run.',
          deleteError.message
        );
      } else {
        // Log but don't throw - allow app to continue
        console.error(
          '[backup] Error deleting backup directory:',
          deleteError.message
        );
      }
    }
  } catch (error: any) {
    console.error('[backup] Error restoring backup:', error.message);
    // Don't throw - allow the app to continue even if backup restoration fails
  }

  return { needsAddonReinstall };
}

/**
 * Reinstalls addon dependencies by running setup scripts for each addon.
 * This is called after an update that skipped node_modules during backup.
 */
export async function reinstallAddonDependencies(
  onProgress?: (addon: string, current: number, total: number) => void
): Promise<void> {
  console.log('[startup] Reinstalling addon dependencies...');

  // Check if general config exists
  const configPath = join(__dirname, 'config/option/general.json');
  if (!fs.existsSync(configPath)) {
    console.log('[startup] No general config found, skipping addon reinstall');
    return;
  }

  try {
    const generalConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const addons = generalConfig.addons as string[] | undefined;

    if (!addons || addons.length === 0) {
      console.log('[startup] No addons configured, skipping reinstall');
      return;
    }

    let current = 0;
    for (const addon of addons) {
      current++;
      let addonPath = '';
      let addonName = addon.split(/\/|\\/).pop() ?? 'unknown';

      if (addon.startsWith('local:')) {
        addonPath = addon.split('local:')[1];
      } else {
        addonPath = join(__dirname, 'addons', addonName);
      }

      if (!fs.existsSync(addonPath)) {
        console.log(
          `[startup] Addon ${addonName} not found at ${addonPath}, skipping`
        );
        continue;
      }

      // Check if addon.json exists
      if (!fs.existsSync(join(addonPath, 'addon.json'))) {
        console.log(`[startup] No addon.json for ${addonName}, skipping`);
        continue;
      }

      // Remove the old installation.log to force setup to run
      const installLogPath = join(addonPath, 'installation.log');
      if (fs.existsSync(installLogPath)) {
        try {
          fs.unlinkSync(installLogPath);
          console.log(`[startup] Removed installation.log for ${addonName}`);
        } catch (err: any) {
          console.warn(
            `[startup] Could not remove installation.log for ${addonName}:`,
            err.message
          );
        }
      }

      onProgress?.(addonName, current, addons.length);

      console.log(
        `[startup] Running setup for addon ${addonName} (${current}/${addons.length})`
      );
      try {
        const success = await setupAddon(addonPath);
        if (success) {
          console.log(`[startup] Successfully set up ${addonName}`);
        } else {
          console.error(`[startup] Failed to set up ${addonName}`);
        }
      } catch (setupError: any) {
        console.error(
          `[startup] Error setting up ${addonName}:`,
          setupError.message
        );
        // Continue with other addons
      }
    }

    console.log('[startup] Addon dependency reinstallation complete');
  } catch (error: any) {
    console.error(
      '[startup] Failed to reinstall addon dependencies:',
      error.message
    );
  }
}

export async function convertLibrary() {
  // read the library directory
  const libraryPath = join(__dirname, 'library/');
  if (!fs.existsSync(libraryPath)) {
    return;
  }
  const files = fs.readdirSync(libraryPath);
  for (const file of files) {
    const filePath = join(libraryPath, file);
    const fileData = fs.readFileSync(filePath, 'utf-8');
    let data: LibraryInfo & { steamAppID?: number } = JSON.parse(fileData);
    if (data.steamAppID) {
      // convert the app id to an appID
      data.appID = data.steamAppID;
      delete data.steamAppID;
      data.coverImage = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${data.appID}/library_hero.jpg`;
      data.titleImage = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${data.appID}/logo_2x.png`;
      data.addonsource = 'steam';
      data.storefront = 'steam';
      fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
      console.log(`Converted ${file} to new format`);
    }
  }
}
async function checkForGitUpdates(repoPath: string): Promise<boolean> {
  // Change the directory to the repository path and run 'git fetch --dry-run'
  return new Promise((resolve, _) => {
    exec(
      'git fetch --dry-run',
      {
        cwd: repoPath,
        env: { ...process.env, LANG: 'en_US.UTF-8', LD_PRELOAD: '' },
      },
      (error, stdout, stderr) => {
        if (error) {
          sendNotification({
            message: 'Failed to check for updates',
            id: Math.random().toString(36).substring(7),
            type: 'error',
          });
          console.log(error);
          resolve(false);
          return;
        }

        // If stdout is not empty, it means there are updates
        // auto remove the warning:
        const output = stdout + stderr;
        const cleanedOutput = output.replace(/warning: redirecting to .*/, '');
        console.log(cleanedOutput);

        if (cleanedOutput.trim()) {
          resolve(true);
        } else {
          resolve(false);
        }
      }
    );
  });
}

export function checkForAddonUpdates(mainWindow: BrowserWindow) {
  if (!fs.existsSync(join(__dirname, 'addons'))) {
    return;
  }
  const generalConfig = JSON.parse(
    fs.readFileSync(join(__dirname, 'config/option/general.json'), 'utf-8')
  );
  const addons = generalConfig.addons;
  for (const addon of addons) {
    let addonPath = '';
    let addonName = addon.split(/\/|\\/).pop()!!;
    if (addon.startsWith('local:')) {
      addonPath = addon.split('local:')[1];
    } else {
      addonPath = join(__dirname, 'addons', addonName);
    }

    if (!fs.existsSync(addonPath + '/.git')) {
      console.log(`Addon ${addonName} is not a git repository`);
      continue;
    }

    new Promise<void>(async (resolve, _) => {
      const isUpdate = await checkForGitUpdates(addonPath);
      if (isUpdate) {
        sendNotification({
          message: `Addon ${addonName} has updates.`,
          id: Math.random().toString(36).substring(7),
          type: 'info',
        });
        mainWindow!!.webContents.send('addon:update-available', addon);
        console.log(`Addon ${addonName} has updates.`);
        resolve();
      }
      console.log(`Addon ${addonName} is up to date.`);
      resolve();
    });
  }
}

export async function removeCachedAppUpdates() {
  // find cached updates in the temp folder of this system
  const tempFolder = app.getPath('temp');
  const cachedUpdates = (await fsPromises.readdir(tempFolder)).filter((file) =>
    file.startsWith('ogi-')
  );

  // count how many cached updates there are, then sort from oldest to newest based on ogi-{version}-cache using semver
  const sortedUpdates = cachedUpdates.sort((a, b) => {
    const aVersion = a.split('-')[1];
    const bVersion = b.split('-')[1];
    if (aVersion.includes('update')) {
      return -1;
    }
    if (bVersion.includes('update')) {
      return 1;
    }

    if (!semver.valid(aVersion) || !semver.valid(bVersion)) {
      return 0;
    }
    return semver.compare(aVersion, bVersion);
  });

  // remove all but the newest 3 cached updates (keep the last 3)
  const toRemove = sortedUpdates.slice(
    0,
    Math.max(0, sortedUpdates.length - 3)
  );
  for (const update of toRemove) {
    await fsPromises.rm(join(tempFolder, update), {
      recursive: true,
      force: true,
    });
  }

  // remove all cached updates that are older than 30 days
  // Only check the remaining updates (the newest 3)
  const toKeep = sortedUpdates.slice(Math.max(0, sortedUpdates.length - 3));
  for (const update of toKeep) {
    try {
      const stats = await fsPromises.stat(join(tempFolder, update));
      const diffTime = Math.abs(Date.now() - stats.mtime.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays > 30) {
        await fsPromises.rm(join(tempFolder, update), {
          recursive: true,
          force: true,
        });
      }
    } catch {
      // Directory may not exist or be inaccessible
    }
  }

  console.log('[chore] Removed cached app updates');
}

export async function downloadLatestUmu(): Promise<DownloadLatestUmuResult> {
  console.log('[umu] Checking local UMU version against latest release');

  let latestVersion = '';
  let installedVersion: string | null = null;

  const FETCH_TIMEOUT_MS = 15000;

  try {
    const releaseController = new AbortController();
    const releaseTimeout = setTimeout(
      () => releaseController.abort(),
      FETCH_TIMEOUT_MS
    );
    let releaseRes: Response;
    try {
      releaseRes = await fetch(UMU_RELEASES_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'OpenGameInstaller',
        },
        signal: releaseController.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        clearTimeout(releaseTimeout);
        return {
          success: false,
          updated: false,
          error: 'Request timed out while fetching UMU release info',
        };
      }
      throw err;
    } finally {
      clearTimeout(releaseTimeout);
    }

    if (!releaseRes.ok) {
      return {
        success: false,
        updated: false,
        error: `GitHub API failed: ${releaseRes.status} ${releaseRes.statusText}`,
      };
    }

    const release = (await releaseRes.json()) as UmuReleaseResponse;
    latestVersion = release.tag_name?.trim() ?? '';
    if (!latestVersion) {
      return {
        success: false,
        updated: false,
        error: 'Latest release did not include a tag_name',
      };
    }

    const zipappAsset = (release.assets ?? []).find((asset) =>
      asset.name.includes('-zipapp.tar')
    );
    if (!zipappAsset?.browser_download_url) {
      return {
        success: false,
        updated: false,
        latestVersion,
        error: 'No zipapp tarball found in latest release',
      };
    }

    installedVersion = await readInstalledUmuVersion();
    const normalizedInstalled = installedVersion
      ? semver.coerce(installedVersion)?.version
      : null;
    const normalizedLatest = semver.coerce(latestVersion)?.version;

    if (
      normalizedInstalled &&
      normalizedLatest &&
      semver.gte(normalizedInstalled, normalizedLatest)
    ) {
      return {
        success: true,
        updated: false,
        currentVersion: installedVersion ?? undefined,
        latestVersion,
      };
    }

    if (
      !normalizedInstalled &&
      installedVersion &&
      installedVersion === latestVersion
    ) {
      return {
        success: true,
        updated: false,
        currentVersion: installedVersion,
        latestVersion,
      };
    }

    if (!fs.existsSync(UMU_BIN_DIR)) {
      fs.mkdirSync(UMU_BIN_DIR, { recursive: true });
    }

    const downloadController = new AbortController();
    const downloadTimeout = setTimeout(
      () => downloadController.abort(),
      FETCH_TIMEOUT_MS
    );
    let downloadRes: Response;
    try {
      downloadRes = await fetch(zipappAsset.browser_download_url, {
        signal: downloadController.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        clearTimeout(downloadTimeout);
        return {
          success: false,
          updated: false,
          currentVersion: installedVersion ?? undefined,
          latestVersion,
          error: 'Request timed out while downloading UMU zipapp',
        };
      }
      throw err;
    } finally {
      clearTimeout(downloadTimeout);
    }

    if (!downloadRes.ok) {
      return {
        success: false,
        updated: false,
        currentVersion: installedVersion ?? undefined,
        latestVersion,
        error: `Download failed: ${downloadRes.status} ${downloadRes.statusText}`,
      };
    }

    const tarballData = Buffer.from(await downloadRes.arrayBuffer());
    fs.writeFileSync(UMU_TARBALL_PATH, tarballData);

    await extractUmuTarball(UMU_TARBALL_PATH);

    if (!fs.existsSync(UMU_RUN_EXECUTABLE)) {
      return {
        success: false,
        updated: false,
        currentVersion: installedVersion ?? undefined,
        latestVersion,
        error: 'UMU run binary not found after extract',
      };
    }

    fs.writeFileSync(UMU_VERSION_FILE, `${latestVersion}\n`);

    return {
      success: true,
      updated: true,
      currentVersion: installedVersion ?? undefined,
      latestVersion,
    };
  } catch (error) {
    return {
      success: false,
      updated: false,
      currentVersion: installedVersion ?? undefined,
      latestVersion: latestVersion || undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (fs.existsSync(UMU_TARBALL_PATH)) {
      try {
        fs.unlinkSync(UMU_TARBALL_PATH);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}
