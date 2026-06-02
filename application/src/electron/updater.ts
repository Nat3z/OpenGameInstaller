import axios from 'axios';
import { app } from 'electron';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  copyFileSync,
  writeFileSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  createReadStream,
} from 'original-fs';
import { basename, dirname, join } from 'path';
import { setTimeout as setTimeoutPromise } from 'timers/promises';
import { spawn, exec } from 'child_process';
import { createHash } from 'crypto';
import * as zlib from 'zlib';
import * as path from 'path';
import { __dirname as persistentDataDir } from '@/electron/manager/manager.paths.js';
import { getEffectiveOnlineState } from '@/electron/lib/online.js';

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

const filesToBackup = ['config', 'addons', 'library', 'internals'];
// Directories to skip during backup (addon dependencies will be reinstalled)
const dirsToSkip = ['node_modules'];
let __dirname = isDev()
  ? app.getAppPath() + '/../'
  : path.dirname(process.execPath);
if (process.platform === 'linux') {
  // it's most likely sandboxed, so just use ./
  __dirname = './';
}

function getBackupSourceRoot() {
  return process.platform === 'linux' ? persistentDataDir : __dirname;
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

  let stat;
  try {
    stat = statSync(source);
  } catch (err: any) {
    console.error(`[updater] Failed to stat ${source}: ${err.message}`);
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
      console.error(`[updater] Failed to copy ${source}: ${error.message}`);
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
        console.log(`[updater] Skipping ${entry} (will be reinstalled)`);
        continue;
      }

      const srcPath = join(source, entry);
      const destPath = join(destination, entry);

      // Recursively yield from subdirectories/files
      yield* copyDirectoryAsync(srcPath, destPath);
    }
  } catch (error: any) {
    console.error(
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
  const sourceRoot = getBackupSourceRoot();

  // First, count total files to backup
  let totalFiles = 0;
  for (const file of filesToBackup) {
    const source = join(sourceRoot, file);
    totalFiles += countFilesToBackup(source);
  }

  console.log(
    `[updater] Total files to backup: ${totalFiles} from ${sourceRoot}`
  );

  rmSync(tempFolder, { recursive: true, force: true });
  mkdirSync(tempFolder, { recursive: true });

  let copiedFiles = 0;
  let failedFiles: string[] = [];
  let needsAddonReinstall = false;

  for (const file of filesToBackup) {
    const source = join(sourceRoot, file);
    const destination = join(tempFolder, file);

    if (!existsSync(source)) {
      console.log(`[updater] Skipping ${file} (does not exist)`);
      continue;
    }

    // Check if this is the addons folder - we'll need to reinstall after
    if (file === 'addons') {
      needsAddonReinstall = true;
    }

    console.log(`[updater] Backing up ${source} to ${destination}`);

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
    console.warn(
      `[updater] Failed to backup ${failedFiles.length} files:`,
      failedFiles.slice(0, 10)
    );
  }

  return {
    success: totalFiles === 0 || failedFiles.length <= totalFiles * 0.1,
    needsAddonReinstall,
  }; // Allow up to 10% failure (inclusive), handle zero files
}

async function downloadFileWithProgress(
  url: string,
  destination: string,
  updateStatus: (text: string, subtext?: string) => void,
  updateProgress: (current: number, total: number, speed: string) => void
) {
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 60000,
  });
  const writer = createWriteStream(destination);
  const startTime = Date.now();
  const fileSize = Number.parseInt(
    String(response.headers['content-length'] ?? '0'),
    10
  );

  response.data.on('data', () => {
    const elapsedTime = Math.max((Date.now() - startTime) / 1000, 1);
    const downloadSpeed = writer.bytesWritten / elapsedTime;
    const formattedSpeed = `${correctParsingSize(downloadSpeed)}/s`;
    updateStatus('Downloading Latest Setup', formattedSpeed);
    updateProgress(writer.bytesWritten, fileSize, formattedSpeed);
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        writer.destroy();
        response.data.destroy(error);
        rmSync(destination, { force: true });
        reject(error);
        return;
      }
      resolve();
    };

    writer.on('finish', () => finish());
    writer.on('error', (error) => finish(error));
    response.data.on('error', (error: Error) => finish(error));
    response.data.pipe(writer);
  });
}

const PATCH_PROGRESS_INTERVAL = 128;
const RANGE_DOWNLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
const RANGE_DOWNLOAD_COALESCE_GAP = 512 * 1024;

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size?: number;
  digest?: string;
};

type GithubRelease = {
  tag_name: string;
  body?: string;
  prerelease?: boolean;
  assets: ReleaseAsset[];
};

function getSetupVersionFromRelease(release: GithubRelease): string | null {
  const match = release.body?.match(/Setup Version: (.*)/);
  return match?.[1]?.trim() ?? null;
}

function getSetupAsset(release: GithubRelease): ReleaseAsset | undefined {
  const suffix =
    process.platform === 'win32' ? '-Setup.exe' : '-Setup.AppImage';
  return release.assets.find((asset) => asset.name.includes(suffix));
}

function getBlockmapAsset(
  release: GithubRelease,
  artifact: ReleaseAsset
): ReleaseAsset | undefined {
  return release.assets.find(
    (asset) =>
      asset.name.toLowerCase() === `${artifact.name.toLowerCase()}.blockmap`
  );
}

function getBlockKey(checksum: string, size: number): string {
  return `${checksum}:${size}`;
}

function parseDigest(
  digest?: string
): { algorithm: string; value: string } | null {
  if (!digest) return null;
  const [algorithm, value] = digest.split(':', 2);
  const normalized = algorithm?.toLowerCase();
  if (!value || !['sha256', 'sha384', 'sha512'].includes(normalized)) {
    return null;
  }
  return { algorithm: normalized, value: value.toLowerCase() };
}

async function hashFile(filePath: string, algorithm: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyReleaseArtifact(
  artifactPath: string,
  expectedArtifact: ReleaseAsset
): Promise<void> {
  const size = statSync(artifactPath).size;
  if (
    Number.isFinite(expectedArtifact.size) &&
    expectedArtifact.size &&
    size !== expectedArtifact.size
  ) {
    throw new Error(
      `Artifact size mismatch: expected ${expectedArtifact.size}, got ${size}`
    );
  }

  const parsedDigest = parseDigest(expectedArtifact.digest);
  if (!parsedDigest) return;

  const actualDigest = await hashFile(artifactPath, parsedDigest.algorithm);
  if (actualDigest !== parsedDigest.value) {
    throw new Error(`Artifact digest mismatch for ${parsedDigest.algorithm}`);
  }
}

async function downloadRangeChunk(
  url: string,
  start: number,
  end: number
): Promise<Buffer> {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'arraybuffer',
    headers: {
      Range: `bytes=${start}-${end}`,
      'Accept-Encoding': 'identity',
    },
    timeout: 60000,
  });

  const expectedSize = end - start + 1;
  const actualSize = Buffer.byteLength(response.data);
  if (response.status !== 206 || actualSize !== expectedSize) {
    throw new Error(`Invalid range response for bytes=${start}-${end}`);
  }

  return Buffer.from(response.data);
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

async function applyBlockmapPatch(params: {
  sourceArtifact: string;
  oldBlockmapPath: string;
  outputArtifact: string;
  newBlockmapPath: string;
  targetUrl: string;
  expectedArtifact: ReleaseAsset;
  updateStatus: (text: string, subtext?: string) => void;
  updateProgress: (current: number, total: number, speed: string) => void;
}): Promise<void> {
  const oldMap = JSON.parse(
    zlib.gunzipSync(readFileSync(params.oldBlockmapPath)).toString('utf8')
  );
  const newMap = JSON.parse(
    zlib.gunzipSync(readFileSync(params.newBlockmapPath)).toString('utf8')
  );
  const oldFile = oldMap.files?.[0];
  const newFile = newMap.files?.[0];
  if (!oldFile || !newFile) throw new Error('Invalid blockmap payload');

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
    sourceFd = openSync(params.sourceArtifact, 'r');
    outFd = openSync(params.outputArtifact, 'w');
    let writeOffset = newFile.offset || 0;
    const misses: Array<{ offset: number; size: number }> = [];

    if (writeOffset > 0) {
      const header = await downloadRangeChunk(
        params.targetUrl,
        0,
        writeOffset - 1
      );
      writeSync(outFd, header, 0, header.length, 0);
    }

    for (let i = 0; i < newFile.checksums.length; i++) {
      const size = newFile.sizes[i];
      const blocks = checksumToBlocks.get(
        getBlockKey(newFile.checksums[i], size)
      );
      const matched = blocks?.pop();
      if (matched) {
        const buffer = Buffer.alloc(size);
        const bytesRead = readSync(sourceFd, buffer, 0, size, matched.offset);
        if (bytesRead !== size)
          throw new Error('Short read from source artifact');
        writeSync(outFd, buffer, 0, size, writeOffset);
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
      const chunk = await downloadRangeChunk(
        params.targetUrl,
        task.start,
        task.end
      );
      writeSync(outFd, chunk, 0, chunk.length, task.start);
      downloaded += chunk.length;
      params.updateStatus('Downloading setup patch data');
      params.updateProgress(downloaded, total, '');
    }
  } finally {
    if (sourceFd !== null) closeSync(sourceFd);
    if (outFd !== null) closeSync(outFd);
  }

  await verifyReleaseArtifact(params.outputArtifact, params.expectedArtifact);
}

async function downloadSetupAppImageWithDifferentialFallback(params: {
  releases: GithubRelease[];
  latestRelease: GithubRelease;
  latestAsset: ReleaseAsset;
  localVersion: string;
  destination: string;
  updateStatus: (text: string, subtext?: string) => void;
  updateProgress: (current: number, total: number, speed: string) => void;
}): Promise<void> {
  const currentSetupPath = '../OpenGameInstaller-Setup.AppImage';
  const newBlockmapAsset = getBlockmapAsset(
    params.latestRelease,
    params.latestAsset
  );
  const previousRelease = params.releases.find(
    (release) => getSetupVersionFromRelease(release) === params.localVersion
  );
  const previousAsset = previousRelease
    ? getSetupAsset(previousRelease)
    : undefined;
  const oldBlockmapAsset =
    previousRelease && previousAsset
      ? getBlockmapAsset(previousRelease, previousAsset)
      : undefined;

  if (existsSync(currentSetupPath) && newBlockmapAsset && oldBlockmapAsset) {
    const tempDir = app.getPath('temp');
    const oldBlockmapPath = join(tempDir, 'ogi-old-setup.blockmap');
    const newBlockmapPath = join(tempDir, 'ogi-new-setup.blockmap');
    try {
      params.updateStatus('Downloading setup blockmaps...');
      await downloadFileWithProgress(
        oldBlockmapAsset.browser_download_url,
        oldBlockmapPath,
        params.updateStatus,
        params.updateProgress
      );
      await downloadFileWithProgress(
        newBlockmapAsset.browser_download_url,
        newBlockmapPath,
        params.updateStatus,
        params.updateProgress
      );
      await applyBlockmapPatch({
        sourceArtifact: currentSetupPath,
        oldBlockmapPath,
        outputArtifact: params.destination,
        newBlockmapPath,
        targetUrl: params.latestAsset.browser_download_url,
        expectedArtifact: params.latestAsset,
        updateStatus: params.updateStatus,
        updateProgress: params.updateProgress,
      });
      console.log('[updater] Setup AppImage differential update succeeded');
      return;
    } catch (error) {
      console.warn(
        '[updater] Setup AppImage differential update failed, falling back to full download:',
        error
      );
      rmSync(params.destination, { force: true });
    } finally {
      rmSync(oldBlockmapPath, { force: true });
      rmSync(newBlockmapPath, { force: true });
    }
  }

  await downloadFileWithProgress(
    params.latestAsset.browser_download_url,
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
        console.log('[updater] Created addon reinstall flag');
      } catch (flagError: any) {
        console.warn(
          '[updater] Failed to create reinstall flag:',
          flagError.message
        );
      }
    }

    if (!backupResult.success) {
      console.warn(
        '[updater] Backup completed with some failures, but continuing...'
      );
    }
  } catch (backupError: any) {
    console.error('[updater] Backup failed:', backupError.message);
    // Continue anyway - better to update with potential data loss than to leave broken
  }
}

/**
 * Format a byte count into a human-readable string using B, KB, MB, or GB.
 *
 * @param size - The size in bytes to format
 * @returns The formatted size string (e.g., `512B`, `1.23KB`, `4.56MB`, `7.89GB`); values for KB and above use two decimal places
 */
function correctParsingSize(size: number) {
  if (size < 1024) {
    return size + 'B';
  } else if (size < 1024 * 1024) {
    return (size / 1024).toFixed(2) + 'KB';
  } else if (size < 1024 * 1024 * 1024) {
    return (size / (1024 * 1024)).toFixed(2) + 'MB';
  } else {
    return (size / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
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
              console.log('[updater] No Setup.AppImage process found to kill');
            } else {
              console.log(
                '[updater] Killed Setup.AppImage process via killall'
              );
            }
            resolve();
          });
        } else {
          console.log('[updater] Killed Setup.AppImage process via pkill');
          resolve();
        }
      });
    }
  });
}
/**
 * Checks GitHub for a newer installer release and, if one is available, downloads it and performs the platform-appropriate update workflow.
 *
 * This performs gated checks for offline mode, network connectivity, and portable runs; reads the local updater version and bleeding-edge flag; queries repository releases with a 10s timeout; chooses a suitable release (respecting prerelease when bleeding-edge is enabled); and, when a newer setup is found, streams the installer download with progress updates via callbacks, backs up configured local files, and then launches (Windows) or replaces and makes executable (Linux) the downloaded setup. Any errors are logged and the function resolves without throwing.
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

    const onlineState = getEffectiveOnlineState();
    if (!onlineState.effectiveOnline) {
      if (onlineState.reason === 'cli-offline') {
        console.log(
          '[updater] Launched in offline mode, skipping update check.'
        );
      } else {
        console.error('[updater] No internet connection available.');
      }
      resolve({ success: true, updated: false });
      return;
    }

    // check dirname of self
    if (basename(__dirname) !== 'update' && process.platform !== 'linux') {
      console.log('[updater] Running portably, skipping update check.');
      console.log(`[updater] Current directory: ${basename(__dirname)}`);
      resolve({ success: true, updated: false });
      return;
    }

    if (process.platform === 'linux') {
      console.log(
        "[updater] Running on linux, most likely running the updater? let's just check to see if the thing exists."
      );
      if (!existsSync('../OpenGameInstaller-Setup.AppImage')) {
        console.error('[updater] No setup found, exiting.');
        resolve({
          success: false,
          updated: false,
          error: 'Setup AppImage not found',
        });
        return;
      }

      console.log('[updater] Setup found, continuing update process.');
    }

    const localVersion = existsSync(`${__dirname}/../updater-version.txt`)
      ? readFileSync(`${__dirname}/../updater-version.txt`, 'utf8') || '0.0.0'
      : '0.0.0';
    console.log(`[updater] Local version: ${localVersion}`);
    const bleedingEdge = existsSync(`${__dirname}/../bleeding-edge.txt`);
    // check for updates
    try {
      const gitRepo = 'nat3z/OpenGameInstaller';
      const releases = await axios.get(
        `https://api.github.com/repos/${gitRepo}/releases`,
        { timeout: 10000 } // 10 second timeout for update check
      );
      let latestRelease: any | undefined = undefined;
      for (const rel of releases.data) {
        if (!rel.body) continue;

        const latestVersionResults = rel.body.match(/Setup Version: (.*)/);
        if (!latestVersionResults || latestVersionResults.length < 2) {
          continue;
        }
        const latestSetupVersion = latestVersionResults[1];
        console.log(latestSetupVersion, localVersion);
        if (latestSetupVersion === localVersion) {
          break;
        }
        if (
          rel.prerelease &&
          bleedingEdge &&
          latestSetupVersion !== localVersion
        ) {
          latestRelease = rel;
          break;
        } else if (!rel.prerelease && latestSetupVersion !== localVersion) {
          latestRelease = rel;
          break;
        }
      }
      if (!latestRelease) {
        console.error('[updater] No new version available.');
        resolve({ success: true, updated: false });
        return;
      }
      const latestVersion = latestRelease.tag_name;
      const latestSetupAsset = getSetupAsset(latestRelease);
      const latestSetupVersionUrl = latestSetupAsset?.browser_download_url;
      if (!latestSetupVersionUrl || !latestSetupAsset) {
        console.error(
          '[updater] No setup version found for the current platform.'
        );
        resolve({
          success: false,
          updated: false,
          error: 'No setup version found for the current platform',
        });
        return;
      }
      console.log(
        `[updater] Latest setup version url: ${latestSetupVersionUrl}`
      );
      // get the latest version of the setup from the description of the release
      const latestVersionResults =
        latestRelease.body.match(/Setup Version: (.*)/);
      if (!latestVersionResults || latestVersionResults.length < 2) {
        console.error(
          '[updater] No setup version found in the release description.'
        );
        resolve({
          success: false,
          updated: false,
          error: 'No setup version found in the release description',
        });
        return;
      }
      const latestSetupVersion = latestVersionResults[1];
      console.log(`[updater] Latest setup version: ${latestSetupVersion}`);
      console.log(`[updater] Latest version: ${latestVersion}`);

      if (latestSetupVersion !== localVersion) {
        console.log(`[updater] New version available: ${latestVersion}`);

        // Kill any running instances of Setup.AppImage or ogi-updater.exe before updating
        updateStatus('Stopping updater processes');
        await killUpdaterProcesses();

        updateStatus('Downloading latest Setup...');
        if (process.platform === 'win32') {
          const directory = app.getPath('temp') + '\\ogi-setup.exe';
          await downloadFileWithProgress(
            latestSetupVersionUrl,
            directory,
            updateStatus,
            updateProgress
          );
          console.log(`[updater] Setup downloaded successfully.`);
          console.log(`[updater] Backing up files in update.`);
          await backupStateForSetupReplacement(updateStatus, updateProgress);

          updateStatus('Starting Setup');

          setTimeout(() => {
            try {
              spawn(directory, {
                detached: true,
                stdio: 'ignore',
              }).unref();
              process.exit(0);
            } catch (spawnError: any) {
              console.error(
                '[updater] Failed to launch setup:',
                spawnError.message
              );
              updateStatus('Update Failed', 'Please try again later');
              process.exit(1);
            }
          }, 500);
          resolve({ success: true, updated: true });
        } else if (process.platform === 'linux') {
          await setTimeoutPromise(3000);
          await downloadSetupAppImageWithDifferentialFallback({
            releases: releases.data,
            latestRelease,
            latestAsset: latestSetupAsset,
            localVersion,
            destination: '../temp-setup-OGI.AppImage',
            updateStatus,
            updateProgress,
          });
          console.log(`[updater] Setup downloaded successfully.`);
          console.log(`[updater] Backing up files in update.`);
          await backupStateForSetupReplacement(updateStatus, updateProgress);

          updateStatus('Starting Setup');

          setTimeout(async () => {
            try {
              // rename the temp-setup-OGI.AppImage to the OpenGameInstaller-Setup.AppImage
              console.log(
                `[updater] Renaming setup to OpenGameInstaller-Setup.AppImage`
              );
              rmSync('../OpenGameInstaller-Setup.AppImage', { force: true });
              console.log(
                `[updater] Moving over setup to OpenGameInstaller-Setup.AppImage`
              );
              copyFileSync(
                '../temp-setup-OGI.AppImage',
                '../OpenGameInstaller-Setup.AppImage'
              );
              rmSync('../temp-setup-OGI.AppImage', { force: true });
              console.log(
                `[updater] Copied setup to OpenGameInstaller-Setup.AppImage`
              );

              // set item +x permissions
              chmodSync('../OpenGameInstaller-Setup.AppImage', 0o755);
            } catch (moveError: any) {
              console.error(
                '[updater] Failed to move setup:',
                moveError.message
              );
              updateStatus('Update Failed', 'Please try again later');
              await setTimeoutPromise(3000);
              process.exit(1);
            }
            updateStatus(
              'Shutting Down OpenGameInstaller',
              'Please open OpenGameInstaller again'
            );
            await setTimeoutPromise(3000);
            process.exit(0);
          }, 500);
          resolve({ success: true, updated: true });
        }
      } else {
        console.log(`[updater] No new version available.`);
        resolve({ success: true, updated: false });
      }
    } catch (ex) {
      console.error('[updater] Error while checking for updates: ', ex);
      resolve({
        success: false,
        updated: false,
        error: ex instanceof Error ? ex.message : String(ex),
      });
    }
  });
}
