/**
 * Library CRUD IPC handlers
 * Updated to support UMU (Unified Launcher for Windows Games on Linux)
 */
import { ipcMain } from 'electron';
import { exec } from 'child_process';
import type { LibraryInfo } from 'ogi-addon';
import { isLinux } from './helpers.app/platform.js';
import {
  getSteamAppIdWithFallback,
  getNonSteamGameAppID,
  getVersionedGameName,
  addGameToSteam,
} from './helpers.app/steam.js';
import {
  loadLibraryInfo,
  saveLibraryInfo,
  ensureLibraryDir,
  ensureInternalsDir,
  getAllLibraryFiles,
  removeLibraryFile,
  addToInternalsApps,
  removeFromInternalsApps,
} from './helpers.app/library.js';
import { generateNotificationId } from './helpers.app/notifications.js';
import { sendNotification } from '../main.js';
import { getProtonPrefixPath } from './helpers.app/platform.js';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  launchWithUmu,
  installRedistributablesWithUmu,
  isUmuInstalled,
  installUmu,
  migrateToUmu,
  convertUmuId,
  getUmuWinePrefix,
} from './handler.umu.js';

/**
 * Escapes a string for safe use in shell commands by escaping special characters
 */
function escapeShellArg(arg: string): string {
  return arg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

/**
 * Determine if a game should use UMU mode
 * - If game has `umu` config → use UMU
 * - If game has `legacyMode: true` → use legacy
 * - Otherwise, use UMU if available on Linux
 */
async function shouldUseUmuMode(libraryInfo: LibraryInfo): Promise<boolean> {
  if (!isLinux()) return false;

  // Explicit UMU config
  if (libraryInfo.umu) return true;

  // Explicit legacy mode
  if (libraryInfo.legacyMode) return false;

  // Default: use UMU if installed
  return await isUmuInstalled();
}

export function registerLibraryHandlers(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('app:launch-game', async (_, appid) => {
    ensureLibraryDir();
    ensureInternalsDir();

    const appInfo = loadLibraryInfo(appid);
    if (!appInfo) {
      return;
    }

    // Check if we should use UMU mode
    const useUmu = await shouldUseUmuMode(appInfo);

    if (useUmu) {
      console.log(`[launch] Using UMU mode for ${appInfo.name}`);

      const result = await launchWithUmu(appInfo);

      if (!result.success) {
        console.error('[launch] UMU launch failed:', result.error);
        sendNotification({
          message: `Failed to launch game: ${result.error}`,
          id: generateNotificationId(),
          type: 'error',
        });
        mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
        return;
      }

      mainWindow?.webContents.send('game:launch', { id: appInfo.appID });

      // Note: We don't wait for game exit with UMU since it's detached
      // The game process is managed by UMU/Proton
      return;
    }

    // Legacy mode (original behavior)
    let args = appInfo.launchArguments || '%command%';
    // replace %command% with the launch executable
    args = args.replace(
      '%command%',
      `"${escapeShellArg(appInfo.launchExecutable)}"`
    );
    console.log('Launching game with args: ' + args, 'in cwd: ' + appInfo.cwd);
    const spawnedItem = exec(args, {
      cwd: appInfo.cwd,
    });
    spawnedItem.on('error', (error) => {
      console.error(error);
      sendNotification({
        message: 'Failed to launch game',
        id: generateNotificationId(),
        type: 'error',
      });
      console.error('Failed to launch game');
      mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
    });
    spawnedItem.on('exit', (exit) => {
      console.log('Game exited with code: ' + exit);
      if (exit !== 0) {
        sendNotification({
          message: 'Game Crashed',
          id: generateNotificationId(),
          type: 'error',
        });

        mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
        return;
      }

      mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
    });

    mainWindow?.webContents.send('game:launch', { id: appInfo.appID });
  });

  ipcMain.handle('app:remove-app', async (_, appid: number) => {
    ensureLibraryDir();
    ensureInternalsDir();

    const appInfo = loadLibraryInfo(appid);
    if (!appInfo) {
      return;
    }

    removeLibraryFile(appid);
    removeFromInternalsApps(appid);
    return;
  });

  ipcMain.handle(
    'app:insert-app',
    async (
      _,
      data: LibraryInfo & {
        redistributables?: { name: string; path: string }[];
      }
    ): Promise<
      | 'setup-failed'
      | 'setup-success'
      | 'setup-redistributables-failed'
      | 'setup-redistributables-success'
      | 'setup-prefix-required'
    > => {
      ensureLibraryDir();
      ensureInternalsDir();

      // Check if UMU is available and should be used
      const umuAvailable = isLinux() && (await isUmuInstalled());

      if (umuAvailable && data.umu) {
        console.log('[setup] Using UMU mode for new game');

        // Ensure UMU is installed
        if (!(await isUmuInstalled())) {
          const installResult = await installUmu();
          if (!installResult.success) {
            console.error('[setup] UMU auto-install failed:', installResult.error);
            // Fall back to legacy mode
            data.legacyMode = true;
          }
        }

        // Set up UMU-specific paths
        const { umuId } = data.umu;
        const winePrefixPath = getUmuWinePrefix(umuId);
        data.umu.winePrefixPath = winePrefixPath;

        // Ensure prefix directory exists
        if (!fs.existsSync(winePrefixPath)) {
          fs.mkdirSync(winePrefixPath, { recursive: true });
        }

        // Save the library info with UMU config
        saveLibraryInfo(data.appID, data);
        addToInternalsApps(data.appID);

        // Handle redistributables
        const hasRedistributables =
          data.redistributables && data.redistributables.length > 0;

        if (hasRedistributables) {
          console.log(
            '[setup] Redistributables detected. Returning setup-prefix-required for UMU.'
          );
          return 'setup-prefix-required';
        }

        return 'setup-success';
      }

      // Legacy mode setup (original behavior)
      data.legacyMode = true;
      saveLibraryInfo(data.appID, data);
      addToInternalsApps(data.appID);

      // linux case (legacy)
      if (isLinux()) {
        // make the launch executable use / instead of \
        data.launchExecutable = data.launchExecutable.replace(/\\/g, '/');

        // Determine if we need to set up wine prefix for redistributables
        const hasRedistributables =
          data.redistributables && data.redistributables.length > 0;

        // Add game to Steam first via steamtinkerlaunch
        const launchOptions = data.launchArguments ?? '';

        // Format game name with version for unique Steam shortcut
        const versionedGameName = getVersionedGameName(data.name, data.version);

        const result = await addGameToSteam({
          name: data.name,
          version: data.version,
          launchExecutable: data.launchExecutable,
          cwd: data.cwd,
          launchOptions,
        });

        // add to the {appid}.json file the launch options
        const { success, appId: steamAppId } =
          await getNonSteamGameAppID(versionedGameName);
        if (!success) {
          return 'setup-failed';
        }
        const protonPath = getProtonPrefixPath(steamAppId!);
        data.launchArguments = 'WINEPREFIX=' + protonPath + ' ' + launchOptions;
        saveLibraryInfo(data.appID, data);

        if (!result) {
          return 'setup-failed';
        }

        // If there are redistributables, we need to wait for the user to create the Proton prefix
        // by launching the game through Steam. Return a special status to trigger the UI flow.
        if (hasRedistributables) {
          console.log(
            '[setup] Redistributables detected. Returning setup-prefix-required status.'
          );
          console.log(
            '[setup] User needs to restart Steam and launch the game to create Proton prefix.'
          );

          // Re-save the data with redistributables preserved for later installation
          saveLibraryInfo(data.appID, data);

          return 'setup-prefix-required';
        }
      } else if (process.platform === 'win32') {
        // if there are redistributables, we need to install them
        if (data.redistributables && data.redistributables.length > 0) {
          let redistributableFailed = false;
          for (const redistributable of data.redistributables) {
            try {
              if (!fs.existsSync(redistributable.path)) {
                throw new Error(
                  `Redistributable path does not exist: ${redistributable.path}`
                );
              }
              spawnSync(redistributable.path, [], {
                stdio: 'inherit',
                shell: false,
              });
              sendNotification({
                message: `Installed ${redistributable.name} for ${data.name}`,
                id: generateNotificationId(),
                type: 'success',
              });
            } catch (error) {
              redistributableFailed = true;
              console.error(
                `[redistributable] failed to install ${redistributable.name} for ${data.name}: ${error}`
              );
            }
          }
          if (redistributableFailed) {
            return 'setup-redistributables-failed';
          }
        }
      }

      return 'setup-success';
    }
  );

  ipcMain.handle('app:get-all-apps', async () => {
    return getAllLibraryFiles();
  });

  ipcMain.handle(
    'app:update-app-version',
    async (
      _,
      data: {
        appID: number;
        version: string;
        cwd: string;
        launchExecutable: string;
        launchArguments?: string;
        addonSource?: string;
        umu?: LibraryInfo['umu'];
      }
    ) => {
      const appData = loadLibraryInfo(data.appID);
      if (!appData) {
        return 'app-not-found';
      }

      if (data.addonSource) {
        appData.addonsource = data.addonSource;
      }

      appData.version = data.version;
      appData.cwd = data.cwd;
      appData.launchExecutable = data.launchExecutable;

      // Handle UMU config if provided
      if (data.umu) {
        appData.umu = data.umu;
        // Update wine prefix path
        appData.umu.winePrefixPath = getUmuWinePrefix(data.umu.umuId);

        // Check if we need to migrate from legacy mode
        if (appData.legacyMode) {
          console.log('[update] Migrating game from legacy to UMU mode');

          // Get the old Steam app ID for migration
          const { success, appId: oldSteamAppId } = await getSteamAppIdWithFallback(
            appData.name,
            appData.version,
            'migration'
          );

          if (success && oldSteamAppId) {
            const migrationResult = await migrateToUmu(data.appID, oldSteamAppId);
            if (!migrationResult.success) {
              console.warn('[update] Migration failed:', migrationResult.error);
              // Continue anyway - UMU will create a fresh prefix
            }
          }

          appData.legacyMode = false;
        }
      }

      // On Linux, handle legacy mode updates
      if (isLinux() && appData.legacyMode) {
        // Preserve the original launch arguments before any modifications
        // Prefer incoming update over existing appData to avoid discarding newly provided edits
        const originalLaunchArguments =
          data.launchArguments ?? appData.launchArguments ?? '';

        // Get the Steam app ID and construct the proton path
        // First try with versioned name, then fallback to plain name if that fails
        const { success, appId } = await getSteamAppIdWithFallback(
          appData.name,
          appData.version,
          'app:update-app-version'
        );

        if (success && appId) {
          // Only modify WINEPREFIX when we successfully get the Steam app ID
          let launchOptions = originalLaunchArguments;

          // Remove any existing WINEPREFIX from launch options
          launchOptions = launchOptions
            .replace(/WINEPREFIX=\S*\s?/g, '')
            .trim();

          const protonPath = getProtonPrefixPath(appId);
          appData.launchArguments =
            'WINEPREFIX=' + protonPath + ' ' + launchOptions;
        } else {
          // If we can't get the Steam app ID, preserve the original launch arguments unchanged
          appData.launchArguments = originalLaunchArguments;
          console.warn(
            `[app:update-app-version] Failed to get Steam app ID for "${getVersionedGameName(appData.name, appData.version)}"${appData.version ? ` and fallback "${appData.name}"` : ''}. Preserving original launch arguments (including any existing WINEPREFIX).`
          );
        }
      } else {
        appData.launchArguments = data.launchArguments;
      }

      saveLibraryInfo(data.appID, appData);
      return 'success';
    }
  );
}
