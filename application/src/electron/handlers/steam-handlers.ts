/**
 * Steam-related IPC handlers
 */
import { ipcMain } from 'electron';
import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import { __dirname } from '../manager/manager.paths.js';
import {
  isLinux,
  getHomeDir,
  getProtonPrefixPath,
} from './helpers.app/platform.js';
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
} from './helpers.app/library.js';
import { generateNotificationId } from './helpers.app/notifications.js';
import { sendNotification } from '../main.js';

export function registerSteamHandlers() {
  ipcMain.handle(
    'app:get-steam-app-id',
    async (
      _,
      appID: number
    ): Promise<{ success: boolean; appId?: number; error?: string }> => {
      if (!isLinux()) {
        return { success: false, error: 'Only available on Linux' };
      }

      const appInfo = loadLibraryInfo(appID);
      if (!appInfo) {
        return { success: false, error: 'Game not found' };
      }

      return await getSteamAppIdWithFallback(
        appInfo.name,
        appInfo.version,
        'app:get-steam-app-id'
      );
    }
  );

  ipcMain.handle('app:kill-steam', async () => {
    if (!isLinux()) {
      return { success: false, error: 'Only available on Linux' };
    }

    console.log('[steam] Attempting to kill Steam process...');

    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      // Try pkill first, then killall as fallback
      exec('steam -shutdown', (error) => {
        if (error) {
          // pkill returns non-zero if no process found, try killall
          exec('killall steam', (error2) => {
            if (error2) {
              console.log('[steam] No Steam process found to kill');
              // Not an error - Steam might not be running
              resolve({ success: true });
            } else {
              console.log('[steam] Steam process killed via killall');
              resolve({ success: true });
            }
          });
        } else {
          console.log('[steam] Steam process killed via pkill');
          resolve({ success: true });
        }
      });
    });
  });

  ipcMain.handle('app:start-steam', async () => {
    if (!isLinux()) {
      return { success: false, error: 'Only available on Linux' };
    }

    console.log('[steam] Starting Steam...');

    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      // Launch Steam detached so it doesn't block
      const child = spawn('steam', [], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();

      let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
        console.log('[steam] Steam launch command executed');
        timeoutId = null;
        resolve({ success: true });
      }, 1000);

      child.on('error', (error) => {
        console.error('[steam] Failed to start Steam:', error);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        resolve({ success: false, error: error.message });
      });

      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[steam] Steam process exited with code ${code}`);
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          resolve({
            success: false,
            error: `Steam process exited with code ${code}`,
          });
        }
      });
    });
  });

  ipcMain.handle('app:launch-steam-app', async (_, appID: number) => {
    if (!isLinux()) {
      return { success: false, error: 'Only available on Linux' };
    }

    const appInfo = loadLibraryInfo(appID);
    if (!appInfo) {
      return { success: false, error: 'Game not found' };
    }

    // Get the Steam shortcut ID
    const { success, appId } = await getSteamAppIdWithFallback(
      appInfo.name,
      appInfo.version,
      'steam'
    );

    if (!success) {
      return { success: false, error: 'Failed to get Steam shortcut ID' };
    }

    console.log(
      `[steam] Launching app via Steam: ${appInfo.name} (shortcut ID: ${appId})`
    );

    return new Promise<{
      success: boolean;
      shortcutId?: number;
      error?: string;
    }>((resolve) => {
      // Use xdg-open to open the steam:// URL
      exec(`xdg-open steam://rungameid/${appId}`, (error) => {
        if (error) {
          console.error('[steam] Failed to launch app via Steam:', error);
          resolve({ success: false, error: error.message });
        } else {
          console.log('[steam] Steam app launch command executed');
          resolve({ success: true, shortcutId: appId });
        }
      });
    });
  });

  ipcMain.handle('app:check-prefix-exists', async (_, appID: number) => {
    if (!isLinux()) {
      return { exists: false, error: 'Only available on Linux' };
    }

    const libraryInfo = loadLibraryInfo(appID);
    if (!libraryInfo) {
      return { exists: false, error: 'Game not found' };
    }

    const { success, appId } = await getSteamAppIdWithFallback(
      libraryInfo.name,
      libraryInfo.version,
      'prefix'
    );

    const homeDir = getHomeDir();
    if (!homeDir) {
      return { exists: false, error: 'Home directory not found' };
    }

    if (!success) {
      return { exists: false, error: 'Failed to get Steam shortcut ID' };
    }

    const prefixPath = getProtonPrefixPath(appId!);
    const exists = fs.existsSync(prefixPath);
    console.log(
      `[prefix] Checking prefix for appID ${appID}: ${exists ? 'exists' : 'not found'} at ${prefixPath}`
    );

    return { exists, prefixPath };
  });

  ipcMain.handle(
    'app:add-to-steam',
    async (_, appID: number, oldSteamAppId: number | undefined) => {
      if (!isLinux()) {
        return { success: false, error: 'Only available on Linux' };
      }

      ensureLibraryDir();

      const appInfo = loadLibraryInfo(appID);
      if (!appInfo) {
        return { success: false, error: 'Game not found' };
      }

      let launchOptions = appInfo.launchArguments ?? '';

      // remove any wineprefix=..... from the launch options
      launchOptions = launchOptions.replace(/WINEPREFIX=\S*\s?/g, '').trim();

      // Format game name with version for unique Steam shortcut
      const versionedGameName = getVersionedGameName(
        appInfo.name,
        appInfo.version
      );

      // Use steamtinkerlaunch to add the game to steam
      const result = await addGameToSteam({
        name: appInfo.name,
        version: appInfo.version,
        launchExecutable: appInfo.launchExecutable,
        cwd: appInfo.cwd,
        launchOptions,
      });

      if (!result) {
        return { success: false };
      }

      // Get the new Steam app ID after adding
      const { success, appId: newSteamAppId } =
        await getNonSteamGameAppID(versionedGameName);

      if (!success || !newSteamAppId) {
        console.warn(
          `[add-to-steam] Failed to get new Steam app ID for "${versionedGameName}"`
        );
        return { success: true }; // Still return success since Steam add worked
      }

      // Save original launchArguments before migration attempt
      const originalLaunchArguments = appInfo.launchArguments;
      let shouldUpdateLaunchArguments = true; // Default to true if no migration needed

      // Migrate prefix if oldSteamAppId is provided and differs from new ID
      console.log('oldSteamAppId', oldSteamAppId);
      console.log('newSteamAppId', newSteamAppId);
      console.log('oldSteamAppId !== 0', oldSteamAppId !== 0);
      console.log(
        'oldSteamAppId !== newSteamAppId',
        oldSteamAppId !== newSteamAppId
      );
      if (
        oldSteamAppId &&
        oldSteamAppId !== 0 &&
        oldSteamAppId !== newSteamAppId
      ) {
        const homeDir = getHomeDir();
        if (!homeDir) {
          console.warn(
            '[add-to-steam] Home directory not found, skipping prefix migration'
          );
          shouldUpdateLaunchArguments = false; // Don't update if home dir not found
        } else {
          const compatDataDir = `${homeDir}/.steam/steam/steamapps/compatdata`;
          const oldAppIdDir = `${compatDataDir}/${oldSteamAppId}`;
          const newAppIdDir = `${compatDataDir}/${newSteamAppId}`;

          try {
            // Check if old app ID directory exists
            if (fs.existsSync(oldAppIdDir)) {
              // Check if new app ID directory already exists
              if (fs.existsSync(newAppIdDir)) {
                console.warn(
                  `[add-to-steam] New compatdata directory already exists at ${newAppIdDir}, skipping migration`
                );
                // New directory already exists, safe to update launchArguments
                shouldUpdateLaunchArguments = true;
              } else {
                // Try to rename first (fastest, works on same filesystem)
                try {
                  fs.renameSync(oldAppIdDir, newAppIdDir);
                  console.log(
                    `[add-to-steam] Successfully migrated compatdata directory from ${oldAppIdDir} to ${newAppIdDir}`
                  );
                  sendNotification({
                    message: `Successfully migrated prefix to new version.`,
                    id: generateNotificationId(),
                    type: 'success',
                  });
                  // Migration succeeded, safe to update launchArguments
                  shouldUpdateLaunchArguments = true;
                } catch (renameError) {
                  // If rename fails (e.g., cross-filesystem), use copy + delete
                  console.log(
                    `[add-to-steam] Rename failed (possibly cross-filesystem), using copy instead`
                  );
                  // Copy recursively
                  const copyRecursiveSync = (src: string, dest: string) => {
                    const exists = fs.existsSync(src);
                    const stats = exists ? fs.statSync(src) : null;
                    const isDirectory = stats?.isDirectory() ?? false;
                    if (isDirectory) {
                      if (!fs.existsSync(dest)) {
                        fs.mkdirSync(dest, { recursive: true });
                      }
                      fs.readdirSync(src).forEach((childItemName) => {
                        copyRecursiveSync(
                          join(src, childItemName),
                          join(dest, childItemName)
                        );
                      });
                    } else {
                      fs.copyFileSync(src, dest);
                    }
                  };
                  copyRecursiveSync(oldAppIdDir, newAppIdDir);
                  // Delete old directory
                  fs.rmSync(oldAppIdDir, { recursive: true, force: true });
                  console.log(
                    `[add-to-steam] Successfully copied compatdata directory from ${oldAppIdDir} to ${newAppIdDir}`
                  );

                  sendNotification({
                    message: `Successfully migrated prefix to new version.`,
                    id: generateNotificationId(),
                    type: 'success',
                  });
                  // Migration succeeded, safe to update launchArguments
                  shouldUpdateLaunchArguments = true;
                }
              }
            } else {
              console.log(
                `[add-to-steam] Old compatdata directory not found at ${oldAppIdDir}, skipping migration`
              );
              sendNotification({
                message: `Old prefix not found, skipping migration`,
                id: generateNotificationId(),
                type: 'error',
              });
              // Old directory doesn't exist, but no error occurred in migration
              // Safe to update launchArguments to new path
              shouldUpdateLaunchArguments = true;
            }
          } catch (migrationError) {
            console.error(
              `[add-to-steam] Error migrating prefix:`,
              migrationError
            );
            // Don't fail the operation if migration fails
            sendNotification({
              message: `Error migrating prefix: ${migrationError}`,
              id: generateNotificationId(),
              type: 'error',
            });
            // Migration failed, restore original launchArguments
            shouldUpdateLaunchArguments = false;
            appInfo.launchArguments = originalLaunchArguments;
          }
        }
      }

      // Update the library JSON with the new WINEPREFIX path only if migration succeeded or not needed
      if (shouldUpdateLaunchArguments) {
        const protonPath = getProtonPrefixPath(newSteamAppId);
        appInfo.launchArguments =
          'WINEPREFIX=' + protonPath + ' ' + launchOptions;
      }
      saveLibraryInfo(appID, appInfo);

      return { success: true };
    }
  );
}
