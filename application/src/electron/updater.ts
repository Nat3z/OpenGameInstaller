import {
  blockmapAsset,
  type ChannelRelease,
  channelStatePath,
  downloadAsset,
  fetchReleases,
  findSetupUpdate,
  formatBytes,
  platformAsset,
  type ReleaseAsset,
  type ReleaseChannel,
  type ReleaseError,
  resolveChannel,
  selectChannel,
  setReleaseFetch,
  setupVersion,
  type UpdateChannel,
  verifyAsset,
} from '@ogi/update-channel';
import { formatError, NetworkError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import axios from 'axios';
import { exec, spawn } from 'child_process';
import { Effect } from 'effect';
import { app, net } from 'electron';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'original-fs';
import * as path from 'path';
import { basename, dirname, join } from 'path';
import { setTimeout as setTimeoutPromise } from 'timers/promises';
import * as zlib from 'zlib';
import { DATABASE_FILENAME, getDatabase } from '@/electron/database/index.js';
import { getEffectiveOnlineState } from '@/electron/lib/online.js';
import { __dirname as dataDirectory } from '@/electron/manager/manager.paths.js';
import { runElectronEffect } from '@/electron/runtime.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

// electron's fetch honors the system and env proxies, unlike node's; it's
// only called once the app is ready
setReleaseFetch((url, init) => net.fetch(url, init));

function isDev() {
  return !app.isPackaged;
}

export interface UpdaterCallbacks {
  onStatus: (text: string, subtext?: string) => void;
  onProgress: (current: number, total: number, speed: string) => void;
}

export type InstallerUpdateResult = {
  success: boolean;
  updated: boolean;
  error?: string;
};

// App state lives in the database, which is snapshotted separately.
const filesToBackup = ['addons'];
// Directories to skip during backup (addon dependencies will be reinstalled)
const dirsToSkip = ['node_modules'];
let __dirname = isDev()
  ? app.getAppPath() + '/../'
  : path.dirname(process.execPath);
if (process.platform === 'linux') {
  // it's most likely sandboxed, so just use ./
  __dirname = './';
}

// The setup installs the application into its update/ directory.
const setupExecutable =
  process.platform === 'win32'
    ? path.resolve(__dirname, '..', 'OpenGameInstaller.exe')
    : path.resolve('../OpenGameInstaller-Setup.AppImage');

/** Channel state is keyed by the setup's directory, or the app's own for portable copies. */
function channelLocation(): {
  root: string;
  statePath: string;
  managed: boolean;
} {
  const managed =
    !isDev() &&
    (process.platform === 'linux'
      ? existsSync(setupExecutable)
      : basename(path.resolve(__dirname)) === 'update');
  const root = managed ? join(__dirname, '..') : __dirname;
  return {
    root,
    statePath: channelStatePath(app.getPath('appData'), root),
    managed,
  };
}

export type ChannelInfo = {
  channel: UpdateChannel;
  /** Whether a setup manages this installation and can apply a switch. */
  managed: boolean;
};

export function getUpdateChannel(): ChannelInfo {
  const { root, statePath, managed } = channelLocation();
  return {
    channel: resolveChannel(statePath, root, 'application', app.getVersion()),
    managed,
  };
}

/** Saves a release-feed channel; the setup installs its build on the next launch. */
export function setUpdateChannel(channel: ReleaseChannel): void {
  const { root, statePath } = channelLocation();
  const setupVersionPath = join(root, 'updater-version.txt');
  selectChannel(statePath, root, channel, {
    application: app.getVersion(),
    ...(existsSync(setupVersionPath)
      ? { setup: readFileSync(setupVersionPath, 'utf8') }
      : {}),
  });
}

/**
 * Closes the app and relaunches the setup once shutdown cleanup has released the
 * addon server port, since the setup refuses to start beside a running instance.
 */
export function relaunchThroughSetup(
  mainWindow: Electron.BrowserWindow | null,
  args: string[] = []
): void {
  if (!channelLocation().managed)
    throw new Error('This installation is not managed by the setup');
  // Drop this AppImage's runtime variables so the setup AppImage mounts its own.
  const { APPDIR, APPIMAGE, ARGV0, OWD, ...env } = process.env;
  app.once('quit', () => {
    spawn(
      setupExecutable,
      process.platform === 'linux' ? [...args, '--no-sandbox'] : args,
      {
        cwd: path.dirname(setupExecutable),
        detached: true,
        stdio: 'ignore',
        env,
      }
    ).unref();
  });
  // Closing the window quits the app; headless has none, so quit directly.
  if (mainWindow) mainWindow.close();
  else app.quit();
}

/**
 * Counts the total number of files to backup, excluding specified directories.
 */
function countFilesToBackup(sourcePath: string): number {
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
      if (dirsToSkip.includes(entry)) continue;
      const fullPath = join(sourcePath, entry);
      count += countFilesToBackup(fullPath);
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
async function* copyDirectoryAsync(
  source: string,
  destination: string
): AsyncGenerator<{ file: string; success: boolean; error?: string }> {
  if (!existsSync(source)) return;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(source);
  } catch (err: any) {
    logger.sync.error(`[updater] Failed to stat ${source}: ${err.message}`);
    yield { file: source, success: false, error: err.message };
    return;
  }
  if (!stat.isDirectory()) {
    // It's a file, copy it
    try {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      yield { file: source, success: true };
    } catch (error: any) {
      logger.sync.error(`[updater] Failed to copy ${source}: ${error.message}`);
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
      if (dirsToSkip.includes(entry)) {
        logger.sync.info(`[updater] Skipping ${entry} (will be reinstalled)`);
        continue;
      }

      const srcPath = join(source, entry);
      const destPath = join(destination, entry);

      // Recursively yield from subdirectories/files
      yield* copyDirectoryAsync(srcPath, destPath);
    }
  } catch (error: any) {
    logger.sync.error(
      `[updater] Failed to read directory ${source}: ${error.message}`
    );
    yield { file: source, success: false, error: error.message };
  }
}

/**
 * Performs async backup of files with progress updates.
 * Returns a promise that resolves when backup is complete.
 */
async function backupFilesAsync(
  tempFolder: string,
  updateStatus: (text: string, subtext?: string) => void,
  updateProgress: (current: number, total: number, speed: string) => void
): Promise<{ success: boolean; needsAddonReinstall: boolean }> {
  // Backed up from the data directory (where the database and addons live),
  // which `restoreBackup` also writes back into.
  const sourceRoot = dataDirectory;

  // First, count total files to backup (plus the database snapshot)
  let totalFiles = 1;
  for (const file of filesToBackup) {
    const source = join(sourceRoot, file);
    totalFiles += countFilesToBackup(source);
  }

  logger.sync.info(
    `[updater] Total files to backup: ${totalFiles} from ${sourceRoot}`
  );

  rmSync(tempFolder, { recursive: true, force: true });
  mkdirSync(tempFolder, { recursive: true });

  let copiedFiles = 0;
  let failedFiles: string[] = [];
  let needsAddonReinstall = false;

  // The database stays open and keeps taking writes during the backup, so a
  // file copy could tear; VACUUM INTO writes a consistent snapshot instead.
  try {
    getDatabase().backup(join(tempFolder, DATABASE_FILENAME));
    copiedFiles++;
  } catch (cause) {
    logger.sync.error('[updater] Could not snapshot the database', cause);
    failedFiles.push(DATABASE_FILENAME);
  }

  for (const file of filesToBackup) {
    const source = join(sourceRoot, file);
    const destination = join(tempFolder, file);

    if (!existsSync(source)) {
      logger.sync.info(`[updater] Skipping ${file} (does not exist)`);
      continue;
    }

    // Check if this is the addons folder - we'll need to reinstall after
    if (file === 'addons') {
      needsAddonReinstall = true;
    }

    logger.sync.info(`[updater] Backing up ${source} to ${destination}`);

    for await (const result of copyDirectoryAsync(source, destination)) {
      copiedFiles++;

      // Update progress periodically (every 10 files or so to avoid UI spam)
      if (copiedFiles % 10 === 0 || copiedFiles === totalFiles) {
        const progress =
          totalFiles > 0 ? Math.round((copiedFiles / totalFiles) * 100) : 100;
        updateStatus(
          'Backing up files',
          `${progress}% (${copiedFiles}/${totalFiles})`
        );
        updateProgress(copiedFiles, totalFiles, '');
      }

      if (!result.success) {
        failedFiles.push(result.file);
      }

      // Yield to event loop to prevent UI freezing
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (failedFiles.length > 0) {
    logger.sync.warn(
      `[updater] Failed to backup ${failedFiles.length} files:`,
      failedFiles.slice(0, 10)
    );
  }

  return {
    success: totalFiles === 0 || failedFiles.length <= totalFiles * 0.1,
    needsAddonReinstall,
  }; // Allow up to 10% failure (inclusive), handle zero files
}

function downloadSetupAsset(
  asset: ReleaseAsset,
  destination: string,
  updateStatus: (text: string, subtext?: string) => void,
  updateProgress: (current: number, total: number, speed: string) => void
): Promise<void> {
  return runElectronEffect(
    downloadAsset(asset, destination, {
      onProgress: ({ written, total, bytesPerSecond }) => {
        const speed = `${formatBytes(bytesPerSecond)}/s`;
        updateStatus('Downloading Latest Setup', speed);
        updateProgress(written, total ?? asset.size, speed);
      },
      onRetry: (attempt, attempts) =>
        updateStatus(
          'Downloading Latest Setup',
          `Retrying (${attempt}/${attempts})`
        ),
    })
  );
}

const PATCH_PROGRESS_INTERVAL = 128;
const RANGE_DOWNLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
const RANGE_DOWNLOAD_COALESCE_GAP = 512 * 1024;

function getBlockKey(checksum: string, size: number): string {
  return `${checksum}:${size}`;
}

function downloadRangeChunk(
  url: string,
  start: number,
  end: number
): Effect.Effect<Buffer, NetworkError | ValidationError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        axios({
          url,
          method: 'GET',
          responseType: 'arraybuffer',
          headers: {
            Range: `bytes=${start}-${end}`,
            'Accept-Encoding': 'identity',
          },
          timeout: 60000,
        }),
      catch: (cause) =>
        new NetworkError({
          message: `Failed to download bytes=${start}-${end}: ${formatError(cause)}`,
          url,
        }),
    });

    const expectedSize = end - start + 1;
    const actualSize = Buffer.byteLength(response.data);
    if (response.status !== 206 || actualSize !== expectedSize) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Invalid range response for bytes=${start}-${end}`,
          field: 'rangeResponse',
        })
      );
    }

    return Buffer.from(response.data);
  });
}

function createRangeDownloadTasks(
  misses: Array<{ offset: number; size: number }>
) {
  const coalescedRanges: Array<{ offset: number; size: number }> = [];
  for (const miss of misses) {
    const last = coalescedRanges[coalescedRanges.length - 1];
    const missEnd = miss.offset + miss.size;
    if (
      last &&
      miss.offset - (last.offset + last.size) <= RANGE_DOWNLOAD_COALESCE_GAP
    ) {
      last.size = missEnd - last.offset;
    } else {
      coalescedRanges.push({ ...miss });
    }
  }

  const tasks: Array<{ start: number; end: number; size: number }> = [];
  for (const range of coalescedRanges) {
    let start = range.offset;
    const end = range.offset + range.size - 1;
    while (start <= end) {
      const chunkEnd = Math.min(start + RANGE_DOWNLOAD_CHUNK_SIZE - 1, end);
      tasks.push({ start, end: chunkEnd, size: chunkEnd - start + 1 });
      start = chunkEnd + 1;
    }
  }
  return tasks;
}

function applyBlockmapPatch(params: {
  sourceArtifact: string;
  oldBlockmapPath: string;
  outputArtifact: string;
  newBlockmapPath: string;
  targetUrl: string;
  expectedArtifact: ReleaseAsset;
  updateStatus: (text: string, subtext?: string) => void;
  updateProgress: (current: number, total: number, speed: string) => void;
}): Effect.Effect<void, NetworkError | ValidationError | ReleaseError> {
  return Effect.gen(function* () {
    const { oldMap, newMap } = yield* Effect.try({
      try: () => ({
        oldMap: JSON.parse(
          zlib.gunzipSync(readFileSync(params.oldBlockmapPath)).toString('utf8')
        ),
        newMap: JSON.parse(
          zlib.gunzipSync(readFileSync(params.newBlockmapPath)).toString('utf8')
        ),
      }),
      catch: (cause) =>
        new ValidationError({
          message: `Unable to parse blockmap payload: ${formatError(cause)}`,
          field: 'blockmap',
        }),
    });
    const oldFile = oldMap.files?.[0];
    const newFile = newMap.files?.[0];
    if (!oldFile || !newFile) {
      return yield* Effect.fail(
        new ValidationError({
          message: 'Invalid blockmap payload',
          field: 'blockmap',
        })
      );
    }

    const checksumToBlocks = new Map<
      string,
      Array<{ offset: number; size: number }>
    >();
    let oldOffset = oldFile.offset || 0;
    for (let i = 0; i < oldFile.checksums.length; i++) {
      const key = getBlockKey(oldFile.checksums[i], oldFile.sizes[i]);
      const blocks = checksumToBlocks.get(key) ?? [];
      blocks.push({ offset: oldOffset, size: oldFile.sizes[i] });
      checksumToBlocks.set(key, blocks);
      oldOffset += oldFile.sizes[i];
    }

    let sourceFd: number | null = null;
    let outFd: number | null = null;
    try {
      sourceFd = yield* Effect.try({
        try: () => openSync(params.sourceArtifact, 'r'),
        catch: (cause) =>
          new ValidationError({
            message: `Unable to open source artifact: ${formatError(cause)}`,
            field: params.sourceArtifact,
          }),
      });
      outFd = yield* Effect.try({
        try: () => openSync(params.outputArtifact, 'w'),
        catch: (cause) =>
          new ValidationError({
            message: `Unable to open output artifact: ${formatError(cause)}`,
            field: params.outputArtifact,
          }),
      });
      let writeOffset = newFile.offset || 0;
      const misses: Array<{ offset: number; size: number }> = [];

      if (writeOffset > 0) {
        const header = yield* downloadRangeChunk(
          params.targetUrl,
          0,
          writeOffset - 1
        );
        yield* Effect.try({
          try: () => writeSync(outFd!, header, 0, header.length, 0),
          catch: (cause) =>
            new ValidationError({
              message: `Unable to write artifact header: ${formatError(cause)}`,
              field: params.outputArtifact,
            }),
        });
      }

      for (let i = 0; i < newFile.checksums.length; i++) {
        const size = newFile.sizes[i];
        const blocks = checksumToBlocks.get(
          getBlockKey(newFile.checksums[i], size)
        );
        const matched = blocks?.pop();
        if (matched) {
          const buffer = Buffer.alloc(size);
          const bytesRead = yield* Effect.try({
            try: () => readSync(sourceFd!, buffer, 0, size, matched.offset),
            catch: (cause) =>
              new ValidationError({
                message: `Unable to read source artifact: ${formatError(cause)}`,
                field: params.sourceArtifact,
              }),
          });
          if (bytesRead !== size) {
            return yield* Effect.fail(
              new ValidationError({
                message: 'Short read from source artifact',
                field: params.sourceArtifact,
              })
            );
          }
          yield* Effect.try({
            try: () => writeSync(outFd!, buffer, 0, size, writeOffset),
            catch: (cause) =>
              new ValidationError({
                message: `Unable to write patched artifact: ${formatError(cause)}`,
                field: params.outputArtifact,
              }),
          });
        } else {
          misses.push({ offset: writeOffset, size });
        }
        writeOffset += size;
        if (
          i === newFile.checksums.length - 1 ||
          (i + 1) % PATCH_PROGRESS_INTERVAL === 0
        ) {
          params.updateStatus('Building setup patch');
          params.updateProgress(i + 1, newFile.checksums.length, '');
        }
      }

      const tasks = createRangeDownloadTasks(misses);
      let downloaded = 0;
      const total = tasks.reduce((sum, task) => sum + task.size, 0);
      for (const task of tasks) {
        const chunk = yield* downloadRangeChunk(
          params.targetUrl,
          task.start,
          task.end
        );
        yield* Effect.try({
          try: () => writeSync(outFd!, chunk, 0, chunk.length, task.start),
          catch: (cause) =>
            new ValidationError({
              message: `Unable to write downloaded patch data: ${formatError(cause)}`,
              field: params.outputArtifact,
            }),
        });
        downloaded += chunk.length;
        params.updateStatus('Downloading setup patch data');
        params.updateProgress(downloaded, total, '');
      }
    } finally {
      if (sourceFd !== null) {
        yield* Effect.try({
          try: () => closeSync(sourceFd!),
          catch: (cause) =>
            new ValidationError({
              message: `Unable to close source artifact: ${formatError(cause)}`,
              field: params.sourceArtifact,
            }),
        });
      }
      if (outFd !== null) {
        yield* Effect.try({
          try: () => closeSync(outFd!),
          catch: (cause) =>
            new ValidationError({
              message: `Unable to close output artifact: ${formatError(cause)}`,
              field: params.outputArtifact,
            }),
        });
      }
    }

    yield* verifyAsset(params.outputArtifact, params.expectedArtifact);
  });
}

async function downloadSetupAppImageWithDifferentialFallback(params: {
  releases: ChannelRelease[];
  latestRelease: ChannelRelease;
  latestAsset: ReleaseAsset;
  localVersion: string;
  destination: string;
  updateStatus: (text: string, subtext?: string) => void;
  updateProgress: (current: number, total: number, speed: string) => void;
}): Promise<void> {
  const currentSetupPath = '../OpenGameInstaller-Setup.AppImage';
  const newBlockmapAsset = blockmapAsset(
    params.latestRelease,
    params.latestAsset
  );
  const previousRelease = params.releases.find(
    (release) => setupVersion(release) === params.localVersion.trim()
  );
  const previousAsset = previousRelease
    ? platformAsset(previousRelease, 'setup')
    : undefined;
  const oldBlockmapAsset =
    previousRelease && previousAsset
      ? blockmapAsset(previousRelease, previousAsset)
      : undefined;

  if (existsSync(currentSetupPath) && newBlockmapAsset && oldBlockmapAsset) {
    const tempDir = app.getPath('temp');
    const oldBlockmapPath = join(tempDir, 'ogi-old-setup.blockmap');
    const newBlockmapPath = join(tempDir, 'ogi-new-setup.blockmap');
    try {
      params.updateStatus('Downloading setup blockmaps...');
      await downloadSetupAsset(
        oldBlockmapAsset,
        oldBlockmapPath,
        params.updateStatus,
        params.updateProgress
      );
      await downloadSetupAsset(
        newBlockmapAsset,
        newBlockmapPath,
        params.updateStatus,
        params.updateProgress
      );
      await runElectronEffect(
        applyBlockmapPatch({
          sourceArtifact: currentSetupPath,
          oldBlockmapPath,
          outputArtifact: params.destination,
          newBlockmapPath,
          targetUrl: params.latestAsset.browser_download_url,
          expectedArtifact: params.latestAsset,
          updateStatus: params.updateStatus,
          updateProgress: params.updateProgress,
        })
      );
      logger.sync.info(
        '[updater] Setup AppImage differential update succeeded'
      );
      return;
    } catch (error) {
      logger.sync.warn(
        '[updater] Setup AppImage differential update failed, falling back to full download:',
        error
      );
      rmSync(params.destination, { force: true });
    } finally {
      rmSync(oldBlockmapPath, { force: true });
      rmSync(newBlockmapPath, { force: true });
    }
  }

  await downloadSetupAsset(
    params.latestAsset,
    params.destination,
    params.updateStatus,
    params.updateProgress
  );
}

async function backupStateForSetupReplacement(
  updateStatus: (text: string, subtext?: string) => void,
  updateProgress: (current: number, total: number, speed: string) => void
) {
  const tempFolder = join(app.getPath('temp'), 'ogi-update-backup');

  if (process.platform === 'linux') {
    logger.sync.info('[updater] Skipping setup backup on Linux.');
    try {
      rmSync(tempFolder, { recursive: true, force: true });
    } catch (cleanupError: any) {
      logger.sync.warn(
        '[updater] Failed to clean stale Linux update backup:',
        cleanupError.message
      );
    }
    return;
  }

  updateStatus('Backing up Files', 'Calculating...');

  try {
    const backupResult = await backupFilesAsync(
      tempFolder,
      updateStatus,
      updateProgress
    );

    if (backupResult.needsAddonReinstall) {
      try {
        writeFileSync(
          join(tempFolder, 'needs-addon-reinstall.flag'),
          new Date().toISOString()
        );
        logger.sync.info('[updater] Created addon reinstall flag');
      } catch (flagError: any) {
        logger.sync.warn(
          '[updater] Failed to create reinstall flag:',
          flagError.message
        );
      }
    }

    if (!backupResult.success) {
      logger.sync.warn(
        '[updater] Backup completed with some failures, but continuing...'
      );
    }
  } catch (backupError: any) {
    logger.sync.error('[updater] Backup failed:', backupError.message);
    // Continue anyway - better to update with potential data loss than to leave broken
  }
}

/**
 * Kills any running instances of Setup.AppImage or ogi-updater.exe processes.
 * Uses platform-specific commands to terminate the processes.
 * @returns {Promise<void>}
 */
function killUpdaterProcesses(): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // On Windows, the ogi-updater is already killed by the updater process
      resolve();
    } else {
      // On Linux/macOS, use pkill to kill Setup.AppImage processes
      // pkill can match processes by name pattern
      exec('pkill -f "OpenGameInstaller-Setup.AppImage"', (error) => {
        if (error) {
          // Try killall as fallback (without wildcard, just try common names)
          exec('killall -q OpenGameInstaller-Setup.AppImage', (error2) => {
            if (error2) {
              logger.sync.info(
                '[updater] No Setup.AppImage process found to kill'
              );
            } else {
              logger.sync.info(
                '[updater] Killed Setup.AppImage process via killall'
              );
            }
            resolve();
          });
        } else {
          logger.sync.info('[updater] Killed Setup.AppImage process via pkill');
          resolve();
        }
      });
    }
  });
}
/**
 * Checks GitHub for a newer installer release and, if one is available, downloads it and performs the platform-appropriate update workflow.
 *
 * Resolves the persisted update channel, then checks its release feed unless offline or portable.
 * Downloads a newer setup, backs up Windows state, and launches or replaces the installer.
 *
 * @param callbacks - Optional callbacks for status and progress updates (used by splash screen)
 * @returns Resolves when the update check and any initiated update workflow complete (no return value).
 */
export function checkIfInstallerUpdateAvailable(
  callbacks?: UpdaterCallbacks
): Promise<InstallerUpdateResult> {
  return new Promise<InstallerUpdateResult>(async (resolve) => {
    const updateStatus = (text: string, subtext?: string) => {
      if (callbacks) {
        callbacks.onStatus(text, subtext);
      }
    };

    const updateProgress = (current: number, total: number, speed: string) => {
      if (callbacks) {
        callbacks.onProgress(current, total, speed);
      }
    };

    let channel: UpdateChannel;
    try {
      const { root, statePath } = channelLocation();
      channel = resolveChannel(
        statePath,
        root,
        'application',
        app.getVersion()
      );
    } catch (error) {
      logger.sync.error('[updater] Cannot resolve update channel:', error);
      resolve({
        success: false,
        updated: false,
        error: 'Invalid update channel state',
      });
      return;
    }

    const onlineState = getEffectiveOnlineState();
    if (!onlineState.effectiveOnline) {
      if (onlineState.reason === 'cli-offline') {
        logger.sync.info(
          '[updater] Launched in offline mode, skipping update check.'
        );
      } else {
        logger.sync.error('[updater] No internet connection available.');
      }
      resolve({ success: true, updated: false });
      return;
    }

    // check dirname of self
    if (basename(__dirname) !== 'update' && process.platform !== 'linux') {
      logger.sync.info('[updater] Running portably, skipping update check.');
      logger.sync.info(`[updater] Current directory: ${basename(__dirname)}`);
      resolve({ success: true, updated: false });
      return;
    }

    if (process.platform === 'linux') {
      logger.sync.info(
        "[updater] Running on linux, most likely running the updater? let's just check to see if the thing exists."
      );
      if (!existsSync('../OpenGameInstaller-Setup.AppImage')) {
        logger.sync.error('[updater] No setup found, exiting.');
        resolve({
          success: false,
          updated: false,
          error: 'Setup AppImage not found',
        });
        return;
      }

      logger.sync.info('[updater] Setup found, continuing update process.');
    }

    const localVersion = existsSync(`${__dirname}/../updater-version.txt`)
      ? readFileSync(`${__dirname}/../updater-version.txt`, 'utf8') || '0.0.0'
      : '0.0.0';
    logger.sync.info(`[updater] Local version: ${localVersion}`);
    if (channel === 'bleeding-edge') {
      resolve({ success: true, updated: false });
      return;
    }
    // check for updates
    try {
      const releases = await runElectronEffect(fetchReleases(channel, 'setup'));
      const update = findSetupUpdate(releases, localVersion, channel);
      if (!update) {
        logger.sync.info('[updater] No new version available.');
        resolve({ success: true, updated: false });
        return;
      }
      const latestRelease = update.release;
      const latestSetupVersion = update.version;
      const latestSetupAsset = platformAsset(latestRelease, 'setup');
      if (!latestSetupAsset) {
        logger.sync.error(
          '[updater] No setup version found for the current platform.'
        );
        resolve({
          success: false,
          updated: false,
          error: 'No setup version found for the current platform',
        });
        return;
      }
      logger.sync.info(
        `[updater] New setup ${latestSetupVersion} available from ${latestRelease.tag_name}: ${latestSetupAsset.browser_download_url}`
      );
      // Kill any running instances of Setup.AppImage or ogi-updater.exe before updating
      updateStatus('Stopping updater processes');
      await killUpdaterProcesses();

      updateStatus('Downloading latest Setup...');
      if (process.platform === 'win32') {
        const directory = app.getPath('temp') + '\\ogi-setup.exe';
        await downloadSetupAsset(
          latestSetupAsset,
          directory,
          updateStatus,
          updateProgress
        );
        logger.sync.info(`[updater] Setup downloaded successfully.`);
        logger.sync.info(`[updater] Backing up files in update.`);
        await backupStateForSetupReplacement(updateStatus, updateProgress);

        updateStatus('Starting Setup');

        await setTimeoutPromise(500);
        try {
          spawn(directory, {
            detached: true,
            stdio: 'ignore',
          }).unref();
        } catch (spawnError: any) {
          logger.sync.error(
            '[updater] Failed to launch setup:',
            spawnError.message
          );
          updateStatus('Update Failed', 'Please try again later');
          resolve({
            success: false,
            updated: false,
            error: spawnError.message,
          });
          return;
        }
        resolve({ success: true, updated: true });
      } else if (process.platform === 'linux') {
        await setTimeoutPromise(3000);
        await downloadSetupAppImageWithDifferentialFallback({
          releases,
          latestRelease,
          latestAsset: latestSetupAsset,
          localVersion,
          destination: '../temp-setup-OGI.AppImage',
          updateStatus,
          updateProgress,
        });
        logger.sync.info(`[updater] Setup downloaded successfully.`);

        updateStatus('Starting Setup');

        await setTimeoutPromise(500);
        try {
          // Replace the old Setup AppImage only after the download is complete.
          logger.sync.info(
            `[updater] Renaming setup to OpenGameInstaller-Setup.AppImage`
          );
          rmSync('../OpenGameInstaller-Setup.AppImage', { force: true });
          logger.sync.info(
            `[updater] Moving over setup to OpenGameInstaller-Setup.AppImage`
          );
          copyFileSync(
            '../temp-setup-OGI.AppImage',
            '../OpenGameInstaller-Setup.AppImage'
          );
          rmSync('../temp-setup-OGI.AppImage', { force: true });
          logger.sync.info(
            `[updater] Copied setup to OpenGameInstaller-Setup.AppImage`
          );
          chmodSync('../OpenGameInstaller-Setup.AppImage', 0o755);
          // Keep the recorded version in sync with the replaced setup for channel switches.
          writeFileSync('../updater-version.txt', latestSetupVersion.trim());
        } catch (moveError: any) {
          logger.sync.error(
            '[updater] Failed to move setup:',
            moveError.message
          );
          updateStatus('Update Failed', 'Please try again later');
          await setTimeoutPromise(3000);
          resolve({
            success: false,
            updated: false,
            error: moveError.message,
          });
          return;
        }
        updateStatus(
          'Shutting Down OpenGameInstaller',
          'Please open OpenGameInstaller again'
        );
        await setTimeoutPromise(3000);
        resolve({ success: true, updated: true });
      }
    } catch (ex) {
      logger.sync.error('[updater] Error while checking for updates: ', ex);
      resolve({
        success: false,
        updated: false,
        error: ex instanceof Error ? ex.message : String(ex),
      });
    }
  });
}
