import axios from 'axios';
import { app, net } from 'electron';
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
} from 'original-fs';
import { basename, join } from 'path';
import { setTimeout as setTimeoutPromise } from 'timers/promises';
import { spawn, exec } from 'child_process';
import * as path from 'path';

function isDev() {
  return !app.isPackaged;
}

export interface UpdaterCallbacks {
  onStatus: (text: string, subtext?: string) => void;
  onProgress: (current: number, total: number, speed: string) => void;
}

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

/**
 * Counts the total number of files to backup, excluding specified directories.
 */
function countFilesToBackup(sourcePath: string): number {
  if (!existsSync(sourcePath)) return 0;

  const stat = statSync(sourcePath);
  if (!stat.isDirectory()) return 1;

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

  const stat = statSync(source);
  if (!stat.isDirectory()) {
    // It's a file, copy it
    try {
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
  // First, count total files to backup
  let totalFiles = 0;
  for (const file of filesToBackup) {
    const source = join(__dirname, file);
    totalFiles += countFilesToBackup(source);
  }

  console.log(`[updater] Total files to backup: ${totalFiles}`);

  if (!existsSync(tempFolder)) {
    mkdirSync(tempFolder, { recursive: true });
  }

  let copiedFiles = 0;
  let failedFiles: string[] = [];
  let needsAddonReinstall = false;

  for (const file of filesToBackup) {
    const source = join(__dirname, file);
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
    success: failedFiles.length < totalFiles * 0.1,
    needsAddonReinstall,
  }; // Allow up to 10% failure
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
      // On Windows, use taskkill to kill ogi-updater.exe
      exec('taskkill /F /IM ogi-updater.exe', (error) => {
        if (error) {
          // Process might not be running, which is fine
          console.log('[updater] No ogi-updater.exe process found to kill');
        } else {
          console.log('[updater] Killed ogi-updater.exe process');
        }
        resolve();
      });
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
export function checkIfInstallerUpdateAvailable(callbacks?: UpdaterCallbacks) {
  return new Promise<void>(async (resolve) => {
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

    // Check if launched in offline mode via command line argument from updater
    const isOfflineArg = process.argv.some((arg) => arg === '--online=false');
    if (isOfflineArg) {
      console.log('[updater] Launched in offline mode, skipping update check.');
      resolve();
      return;
    }

    if (!net.isOnline()) {
      console.error('[updater] No internet connection available.');
      resolve();
      return;
    }

    // check dirname of self
    if (basename(__dirname) !== 'update' && process.platform !== 'linux') {
      console.log('[updater] Running portably, skipping update check.');
      console.log(`[updater] Current directory: ${basename(__dirname)}`);
      resolve();
      return;
    }

    if (process.platform === 'linux') {
      console.log(
        "[updater] Running on linux, most likely running the updater? let's just check to see if the thing exists."
      );
      if (!existsSync('../OpenGameInstaller-Setup.AppImage')) {
        console.error('[updater] No setup found, exiting.');
        resolve();
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
        resolve();
        return;
      }
      let latestSetupVersionUrl: string | undefined = undefined;
      const latestVersion = latestRelease.tag_name;
      if (process.platform === 'win32') {
        latestSetupVersionUrl = latestRelease.assets.find(
          (asset: { name: string }) => asset.name.includes('-Setup.exe')
        )?.browser_download_url;
      } else if (process.platform === 'linux') {
        latestSetupVersionUrl = latestRelease.assets.find(
          (asset: { name: string }) => asset.name.includes('-Setup.AppImage')
        )?.browser_download_url;
      }
      if (!latestSetupVersionUrl) {
        console.error(
          '[updater] No setup version found for the current platform.'
        );
        resolve();
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
        resolve();
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
        // download the latest setup
        const response = await axios.get(latestSetupVersionUrl, {
          responseType: 'stream',
        });
        if (process.platform === 'win32') {
          const directory = app.getPath('temp') + '\\ogi-setup.exe';
          const writer = createWriteStream(directory);
          response.data.pipe(writer);
          const startTime = Date.now();
          const fileSize = parseInt(response.headers['content-length'] || '0');
          response.data.on('data', () => {
            const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
            const downloadSpeed = response.data.socket.bytesRead / elapsedTime;
            updateStatus(
              'Downloading Latest Setup',
              correctParsingSize(downloadSpeed) + '/s'
            );
            updateProgress(
              writer.bytesWritten,
              fileSize,
              correctParsingSize(downloadSpeed) + '/s'
            );
          });
          writer.on('finish', async () => {
            console.log(`[updater] Setup downloaded successfully.`);
            console.log(`[updater] Backing up files in update.`);
            writer.close();

            // Backup files asynchronously with progress
            const tempFolder = app.getPath('temp') + '/ogi-update-backup';
            try {
              updateStatus('Backing up Files', 'Calculating...');
              const backupResult = await backupFilesAsync(
                tempFolder,
                updateStatus,
                updateProgress
              );

              if (backupResult.needsAddonReinstall) {
                // Create a flag file to trigger addon reinstall on next launch
                try {
                  const flagPath = join(
                    tempFolder,
                    'needs-addon-reinstall.flag'
                  );
                  writeFileSync(flagPath, new Date().toISOString());
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

            updateStatus('Starting Setup');

            setTimeout(() => {
              spawn(directory, {
                detached: true,
                stdio: 'ignore',
              }).unref();
              process.exit(0);
            }, 500);
          });
        } else if (process.platform === 'linux') {
          await setTimeoutPromise(3000);
          const writer = createWriteStream('../temp-setup-OGI.AppImage');
          response.data.pipe(writer);
          const startTime = Date.now();
          const fileSize = parseInt(response.headers['content-length'] || '0');
          response.data.on('data', () => {
            const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
            const downloadSpeed = response.data.socket.bytesRead / elapsedTime;
            updateStatus(
              'Downloading Latest Setup',
              correctParsingSize(downloadSpeed) + '/s'
            );
            updateProgress(
              writer.bytesWritten,
              fileSize,
              correctParsingSize(downloadSpeed) + '/s'
            );
          });
          writer.on('finish', async () => {
            console.log(`[updater] Setup downloaded successfully.`);
            console.log(`[updater] Backing up files in update.`);
            writer.close();

            // Backup files asynchronously with progress
            const tempFolder = app.getPath('temp') + '/ogi-update-backup';
            try {
              updateStatus('Backing up Files', 'Calculating...');
              const backupResult = await backupFilesAsync(
                tempFolder,
                updateStatus,
                updateProgress
              );

              if (backupResult.needsAddonReinstall) {
                // Create a flag file to trigger addon reinstall on next launch
                try {
                  const flagPath = join(
                    tempFolder,
                    'needs-addon-reinstall.flag'
                  );
                  writeFileSync(flagPath, new Date().toISOString());
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
          });
        }
      } else {
        console.log(`[updater] No new version available.`);
        resolve();
      }
    } catch (ex) {
      console.error('[updater] Error while checking for updates: ', ex);
      resolve();
    }
  });
}
