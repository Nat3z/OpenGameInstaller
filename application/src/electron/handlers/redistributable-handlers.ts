/**
 * Redistributable installation handlers
 */
import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import axios from 'axios';
import { join, dirname, basename } from 'path';
import * as fs from 'fs';
import type { LibraryInfo } from 'ogi-addon';
import { isLinux, getProtonPrefixPath } from './helpers.app/platform.js';
import { getSteamAppIdWithFallback } from './helpers.app/steam.js';
import { loadLibraryInfo, saveLibraryInfo } from './helpers.app/library.js';
import { generateNotificationId } from './helpers.app/notifications.js';
import { sendNotification } from '../main.js';
import { __dirname } from '../manager/manager.paths.js';

/**
 * Returns silent/quiet install flags for a given installer path and file name.
 * Used for Windows redistributables (VC++, DirectX, .NET, MSI, NSIS, etc.).
 *
 * @param filePath - Full path to the installer (used for path-based heuristics)
 * @param fileName - File name of the installer (e.g. vcredist_x64.exe)
 * @returns Array of command-line flags for silent installation
 */
const getSilentInstallFlags = (
  filePath: string,
  fileName: string
): string[] => {
  const lowerFileName = fileName.toLowerCase();
  const lowerFilePath = filePath.toLowerCase();

  // Microsoft Visual C++ Redistributables
  if (
    lowerFileName.includes('vcredist') ||
    lowerFileName.includes('vc_redist')
  ) {
    return ['/S', '/v/qn']; // /S for silent, /v/qn for very quiet
  }

  // DirectX redistributables
  if (
    lowerFileName.includes('directx') ||
    lowerFileName.includes('dxwebsetup')
  ) {
    return ['/S'];
  }

  // .NET Framework redistributables
  if (lowerFileName.includes('dotnet') || lowerFileName.includes('netfx')) {
    // Special case for .NET Framework Repair Tool
    if (lowerFileName.includes('netfxrepairtool')) {
      return ['/p']; // Use /p flag for repair tool as requested
    }
    return ['/S', '/v/qn'];
  }

  // MSI installers (msiexec is invoked separately with /i <file> /qn)
  if (lowerFileName.endsWith('.msi')) {
    return ['/qn'];
  }

  // NSIS installers (path-only; many setup.exe are Inno/InstallShield)
  if (lowerFilePath.includes('nsis')) {
    return ['/S'];
  }

  // Inno Setup installers
  if (lowerFileName.includes('inno')) {
    return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
  }

  // InstallShield installers
  if (lowerFileName.includes('installshield')) {
    return ['/S', '/v/qn'];
  }

  // Default fallback - try multiple common flags
  return ['/S'];
};

/**
 * Registers IPC handlers for installing redistributables (e.g. VC++, DirectX)
 * into a game's Proton prefix on Linux.
 */
export function registerRedistributableHandlers(): void {
  ipcMain.handle(
    'app:install-redistributables',
    async (_, appID: number): Promise<'success' | 'failed' | 'not-found'> => {
      if (!isLinux()) {
        return 'failed';
      }

      const appInfo = loadLibraryInfo(appID) as
        | (LibraryInfo & {
            redistributables?: { name: string; path: string }[];
          })
        | null;

      if (!appInfo) {
        return 'not-found';
      }

      if (!appInfo.redistributables || appInfo.redistributables.length === 0) {
        console.log('[redistributable] No redistributables to install');
        return 'success';
      }

      const { success, appId } = await getSteamAppIdWithFallback(
        appInfo.name,
        appInfo.version,
        'redistributable'
      );

      if (!success || !appId) {
        return 'failed';
      }

      let protonPath: string;
      try {
        protonPath = getProtonPrefixPath(appId);
      } catch (error) {
        console.error(
          '[redistributable] Error getting Proton prefix path:',
          error
        );
        sendNotification({
          message:
            'Failed to get Proton prefix path. Please check your Steam installation.',
          id: generateNotificationId(),
          type: 'error',
        });
        return 'failed';
      }

      // Check if the prefix exists
      if (!fs.existsSync(protonPath)) {
        console.error(
          '[redistributable] Proton prefix does not exist:',
          protonPath
        );
        sendNotification({
          message:
            'Proton prefix not found. Please launch the game through Steam first.',
          id: generateNotificationId(),
          type: 'error',
        });
        return 'failed';
      }

      console.log(
        `[redistributable] Installing ${appInfo.redistributables.length} redistributables for ${appInfo.name}`
      );

      // Install redistributables using winetricks/flatpak wine
      for (const redistributable of appInfo.redistributables) {
        try {
          sendNotification({
            message: `Installing ${redistributable.name} for ${appInfo.name}`,
            id: generateNotificationId(),
            type: 'info',
          });

          console.log(
            '[redistributable] Installing:',
            redistributable.name,
            redistributable.path
          );

          const success = await new Promise<boolean>((resolve) => {
            let timeoutId: NodeJS.Timeout | null = null;
            let resolved = false;

            const finalize = (result: boolean) => {
              if (resolved) return;
              resolved = true;
              if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
              resolve(result);
            };

            (async () => {
              try {
                if (
                  redistributable.path === 'microsoft' &&
                  redistributable.name === 'dotnet-repair'
                ) {
                  // Download and run the .NET Framework Repair Tool
                  console.log(
                    '[dotnet-repair] Starting .NET Framework Repair Tool'
                  );
                  const netfxRepairToolUrl =
                    'https://download.microsoft.com/download/2/b/d/2bde5459-2225-48b8-830c-ae19caf038f1/NetFxRepairTool.exe';
                  const toolPath = join(
                    __dirname,
                    'bin',
                    'NetFxRepairTool.exe'
                  );

                  // Create the bin directory if it doesn't exist
                  if (!fs.existsSync(join(__dirname, 'bin'))) {
                    fs.mkdirSync(join(__dirname, 'bin'));
                  }

                  // Download the tool if it doesn't exist
                  if (!fs.existsSync(toolPath)) {
                    console.log(
                      '[dotnet-repair] Downloading .NET Framework Repair Tool...'
                    );
                    const response = await axios({
                      method: 'get',
                      url: netfxRepairToolUrl,
                      responseType: 'stream',
                    });

                    const fileStream = fs.createWriteStream(toolPath);
                    response.data.pipe(fileStream);

                    await new Promise<void>(
                      (downloadResolve, downloadReject) => {
                        fileStream.on('finish', () => {
                          fileStream.close();
                          console.log('[dotnet-repair] Download completed');
                          downloadResolve();
                        });
                        fileStream.on('error', (err) => {
                          console.error('[dotnet-repair] Download error:', err);
                          fileStream.close();
                          try {
                            fs.unlinkSync(toolPath);
                          } catch (unlinkErr) {
                            console.error(
                              '[dotnet-repair] Failed to cleanup file:',
                              unlinkErr
                            );
                          }
                          downloadReject(err);
                        });
                      }
                    );
                  }

                  // Run the tool with wine and /p flag
                  console.log(
                    '[dotnet-repair] Running .NET Framework Repair Tool with wine'
                  );
                  const child = spawn(
                    'flatpak',
                    [
                      `--env=WINEPREFIX=${protonPath}`,
                      `--env=DISPLAY=:0`,
                      `--env=WINEDEBUG=-all`,
                      `--env=WINEDLLOVERRIDES=mscoree,mshtml=`,
                      '--filesystem=host',
                      'run',
                      'org.winehq.Wine',
                      'bin/NetFxRepairTool.exe',
                      '/p',
                    ],
                    {
                      stdio: ['inherit', 'pipe', 'pipe'],
                      cwd: __dirname,
                    }
                  );

                  timeoutId = setTimeout(
                    () => {
                      if (child.pid) {
                        child.kill('SIGTERM');
                      }
                      finalize(false);
                    },
                    5 * 60 * 1000
                  );

                  child.on('close', (code) => {
                    console.log(
                      `[dotnet-repair] process exited with code ${code}`
                    );
                    finalize(code === 0);
                  });

                  child.on('error', (error) => {
                    console.error('[dotnet-repair] Process error:', error);
                    finalize(false);
                  });
                } else if (redistributable.path === 'winetricks') {
                  // Use winetricks via flatpak
                  const child = spawn(
                    'flatpak',
                    [
                      `--env=WINEPREFIX=${protonPath}`,
                      `--env=DISPLAY=:0`,
                      `--env=WINEDEBUG=-all`,
                      `--env=WINEDLLOVERRIDES=mscoree,mshtml=`,
                      '--filesystem=host',
                      '--command=winetricks',
                      'run',
                      'org.winehq.Wine',
                      redistributable.name,
                      '--force',
                      '--unattended',
                      '-q',
                    ],
                    {
                      stdio: ['inherit', 'pipe', 'pipe'],
                      cwd: __dirname,
                    }
                  );

                  timeoutId = setTimeout(
                    () => {
                      if (child.pid) {
                        child.kill('SIGTERM');
                      }
                      finalize(false);
                    },
                    10 * 60 * 1000
                  );

                  child.on('close', (code) => {
                    console.log(
                      `[winetricks] process exited with code ${code}`
                    );
                    finalize(code === 0);
                  });

                  child.on('error', (error) => {
                    console.error('[winetricks] Process error:', error);
                    finalize(false);
                  });
                } else {
                  // Regular redistributable file
                  const redistributablePath = redistributable.path
                    .trim()
                    .replace(/\n$/g, '');
                  const redistributableDir = dirname(redistributablePath);
                  const redistributableFilename = basename(redistributablePath);
                  const isMsi = redistributableFilename
                    .toLowerCase()
                    .endsWith('.msi');

                  const silentFlags = getSilentInstallFlags(
                    redistributablePath,
                    redistributableFilename
                  );

                  const wineProgram = isMsi ? 'msiexec' : redistributableFilename;
                  const wineArgs = isMsi
                    ? ['/i', redistributableFilename, ...silentFlags]
                    : [...silentFlags];

                  const child = spawn(
                    'flatpak',
                    [
                      `--env=WINEPREFIX=${protonPath}`,
                      `--env=DISPLAY=:0`,
                      `--env=WINEDEBUG=-all`,
                      `--env=WINEDLLOVERRIDES=mscoree,mshtml=`,
                      '--filesystem=host',
                      'run',
                      'org.winehq.Wine',
                      wineProgram,
                      ...wineArgs,
                    ],
                    {
                      stdio: ['ignore', 'pipe', 'pipe'],
                      cwd: redistributableDir,
                    }
                  );

                  timeoutId = setTimeout(
                    () => {
                      if (child.pid) {
                        child.kill('SIGTERM');
                      }
                      finalize(false);
                    },
                    10 * 60 * 1000
                  );

                  child.on('close', (code) => {
                    console.log(
                      `[redistributable] process exited with code ${code}`
                    );
                    finalize(code === 0);
                  });

                  child.on('error', (error) => {
                    console.error('[redistributable] Process error:', error);
                    finalize(false);
                  });
                }
              } catch (error) {
                console.error('[redistributable] Error:', error);
                finalize(false);
              }
            })().catch((err) => {
              console.error('[redistributable] Promise error:', err);
              finalize(false);
            });
          });

          if (success) {
            sendNotification({
              message: `Installed ${redistributable.name} for ${appInfo.name}`,
              id: generateNotificationId(),
              type: 'success',
            });
          } else {
            sendNotification({
              message: `Failed to install ${redistributable.name} for ${appInfo.name}`,
              id: generateNotificationId(),
              type: 'error',
            });
          }
        } catch (error) {
          console.error(
            `[redistributable] Error installing ${redistributable.name}:`,
            error
          );
          sendNotification({
            message: `Failed to install ${redistributable.name} for ${appInfo.name}`,
            id: generateNotificationId(),
            type: 'error',
          });
        }
      }

      // Clear redistributables from the library file after installation
      delete appInfo.redistributables;
      saveLibraryInfo(appID, appInfo);

      sendNotification({
        message: `Finished installing redistributables for ${appInfo.name}`,
        id: generateNotificationId(),
        type: 'success',
      });

      return 'success';
    }
  );
}
