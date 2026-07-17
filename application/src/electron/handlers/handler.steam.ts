/**
 * Steam-related IPC handlers
 * Updated to support UMU shortcuts and --game-id launch
 */

import { FileSystemError, formatError, ipcBoundary } from '@ogi/errors';
import { exec, spawn } from 'child_process';
import { Effect } from 'effect';
import { ipcMain } from 'electron';
import * as fs from 'fs';
import { join } from 'path';
import {
  ensureLibraryDir,
  loadLibraryInfo,
  saveLibraryInfo,
} from '@/electron/handlers/helpers.app/library.js';
import { generateNotificationId } from '@/electron/handlers/helpers.app/notifications.js';
import {
  getHomeDir,
  getOgiExecutablePath,
  getProtonPrefixPath,
  isLinux,
} from '@/electron/handlers/helpers.app/platform.js';
import {
  addGameToSteam,
  getNonSteamGameAppID,
  getSteamAppIdWithFallback,
  getVersionedGameName,
} from '@/electron/handlers/helpers.app/steam.js';
import { sendNotification } from '@/electron/main.js';

const copyRecursiveSync = (source: string, destination: string): void => {
  const stats = fs.lstatSync(source);
  if (stats.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
  } else if (stats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const child of fs.readdirSync(source)) {
      copyRecursiveSync(join(source, child), join(destination, child));
    }
  } else {
    fs.copyFileSync(source, destination);
  }
};

const migrateCompatData = (
  source: string,
  destination: string
): Effect.Effect<void, FileSystemError> =>
  Effect.try({
    try: () => fs.renameSync(source, destination),
    catch: (cause) =>
      new FileSystemError({ message: formatError(cause), path: source, cause }),
  }).pipe(
    Effect.orElse(() =>
      Effect.try({
        try: () => {
          copyRecursiveSync(source, destination);
          fs.rmSync(source, { recursive: true, force: true });
        },
        catch: (cause) =>
          new FileSystemError({
            message: formatError(cause),
            path: source,
            cause,
          }),
      })
    )
  );

/**
 * Add a UMU game to Steam using OGI wrapper launches.
 */
export function addUmuGameToSteam(params: {
  appID: number;
  name: string;
  version?: string;
}): Effect.Effect<{ success: boolean; error?: string; steamAppId?: number }> {
  return Effect.gen(function* () {
    if (!isLinux()) {
      return { success: false, error: 'Only available on Linux' };
    }

    const appInfo = loadLibraryInfo(params.appID);
    if (!appInfo || !appInfo.umu) {
      return { success: false, error: 'Game is not configured for UMU mode' };
    }

    const result = yield* addGameToSteam({
      name: params.name,
      version: params.version,
      launchExecutable: appInfo.launchExecutable,
      cwd: appInfo.cwd,
      wrapperCommand: '%command%',
      appID: params.appID,
      compatibilityTool: 'proton_experimental',
    });

    if (!result) {
      return { success: false, error: 'Failed to add game to Steam' };
    }

    const steamAppId = yield* getSteamAppIdWithFallback(
      params.name,
      params.version,
      'addGameToSteam'
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    return steamAppId ? { success: true, steamAppId } : { success: true };
  });
}

/**
 * Launch a Steam game by app ID via xdg-open. Returns a Promise with
 * { success, shortcutId?, error? } for use by both UMU and legacy launch paths.
 */
function launchViaSteam(appId: number): Effect.Effect<{
  success: boolean;
  shortcutId?: number;
  error?: string;
}> {
  return Effect.async((resume) => {
    exec(`xdg-open steam://rungameid/${appId}`, (error) => {
      if (error) {
        console.error('[steam] Failed to launch app via Steam:', error);
        resume(Effect.succeed({ success: false, error: error.message }));
      } else {
        console.log('[steam] Steam app launch command executed');
        resume(Effect.succeed({ success: true, shortcutId: appId }));
      }
    });
  });
}

/**
 * Create a .desktop entry for Steam shortcut that launches OGI with --game-id
 * This is an alternative to steamtinkerlaunch
 */
export function createSteamShortcutDesktop(params: {
  appID: number;
  name: string;
  version?: string;
}): Effect.Effect<{ success: boolean; error?: string }> {
  return Effect.sync(() => {
    if (!isLinux()) {
      return { success: false, error: 'Only available on Linux' };
    }

    const homeDir = getHomeDir();
    if (!homeDir) {
      return { success: false, error: 'Home directory not found' };
    }

    const versionedGameName = getVersionedGameName(params.name, params.version);
    const sanitizedGameName = versionedGameName
      .replace(new RegExp('[\\r\\n\\x00-\\x1F=]', 'g'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const ogiPath = getOgiExecutablePath();

    // Create .desktop file for Steam
    const desktopEntry = `[Desktop Entry]
Name=${sanitizedGameName}
Exec="${ogiPath}" --game-id=${params.appID}
Type=Application
Categories=Game;
Icon=steam_icon_${params.appID}
`;

    const result = Effect.runSync(
      Effect.either(
        Effect.try({
          try: () => {
            const desktopDir = join(homeDir, '.local', 'share', 'applications');
            fs.mkdirSync(desktopDir, { recursive: true });
            const desktopFile = join(desktopDir, `ogi-${params.appID}.desktop`);
            fs.writeFileSync(desktopFile, desktopEntry);
            fs.chmodSync(desktopFile, '755');
          },
          catch: (cause) =>
            new FileSystemError({ message: formatError(cause), cause }),
        })
      )
    );
    return result._tag === 'Right'
      ? { success: true }
      : { success: false, error: result.left.message };
  });
}

export function registerSteamHandlers() {
  // Get Steam app ID (legacy - for backward compatibility)
  ipcMain.handle(
    'app:get-steam-app-id',
    ipcBoundary(
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

        return Effect.runPromise(
          getSteamAppIdWithFallback(
            appInfo.name,
            appInfo.version,
            'app:get-steam-app-id'
          ).pipe(
            Effect.map((appId) => ({ success: true as const, appId })),
            Effect.catchAll((error) =>
              Effect.succeed({
                success: false as const,
                error: formatError(error),
              })
            )
          )
        );
      }
    )
  );

  // Kill Steam process
  ipcMain.handle(
    'app:kill-steam',
    ipcBoundary(async () => {
      if (!isLinux()) {
        return { success: false, error: 'Only available on Linux' };
      }

      console.log('[steam] Attempting to kill Steam process...');

      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        // Try steam -shutdown first, then killall as fallback
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
    })
  );

  // Start Steam
  ipcMain.handle(
    'app:start-steam',
    ipcBoundary(async () => {
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
    })
  );

  // Launch Steam app (legacy - for backward compatibility)
  ipcMain.handle(
    'app:launch-steam-app',
    ipcBoundary(async (_, appID: number) => {
      if (!isLinux()) {
        return { success: false, error: 'Only available on Linux' };
      }

      const appInfo = loadLibraryInfo(appID);
      if (!appInfo) {
        return { success: false, error: 'Game not found' };
      }

      // Check if this is a UMU game
      if (appInfo.umu) {
        // For UMU games, only add shortcut if it doesn't already exist
        let appId = await Effect.runPromise(
          getSteamAppIdWithFallback(
            appInfo.name,
            appInfo.version,
            'steam'
          ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        );

        if (!appId) {
          const result = await Effect.runPromise(
            addUmuGameToSteam({
              appID,
              name: appInfo.name,
              version: appInfo.version,
            })
          );
          if (!result.success) {
            return result;
          }
          appId = await Effect.runPromise(
            getSteamAppIdWithFallback(
              appInfo.name,
              appInfo.version,
              'steam'
            ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
          );
        }

        // Launch via Steam

        if (!appId) {
          return { success: false, error: 'Failed to get Steam shortcut ID' };
        }

        return Effect.runPromise(launchViaSteam(appId));
      }

      // Legacy mode
      const appId = await Effect.runPromise(
        getSteamAppIdWithFallback(
          appInfo.name,
          appInfo.version,
          'steam'
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      );

      if (appId == null) {
        return { success: false, error: 'Failed to get Steam shortcut ID' };
      }

      console.log(
        `[steam] Launching app via Steam: ${appInfo.name} (shortcut ID: ${appId})`
      );

      return Effect.runPromise(launchViaSteam(appId));
    })
  );

  // Check if prefix exists (legacy - for backward compatibility)
  ipcMain.handle(
    'app:check-prefix-exists',
    ipcBoundary(async (_, appID: number) => {
      if (!isLinux()) {
        return { exists: false, error: 'Only available on Linux' };
      }

      const libraryInfo = loadLibraryInfo(appID);
      if (!libraryInfo) {
        return { exists: false, error: 'Game not found' };
      }

      // Check if this is a UMU game
      if (libraryInfo.umu?.winePrefixPath) {
        const exists = fs.existsSync(libraryInfo.umu.winePrefixPath);
        return {
          exists,
          prefixPath: libraryInfo.umu.winePrefixPath,
        };
      }

      // Legacy mode
      const appId = await Effect.runPromise(
        getSteamAppIdWithFallback(
          libraryInfo.name,
          libraryInfo.version,
          'prefix'
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      );

      const homeDir = getHomeDir();
      if (!homeDir) {
        return { exists: false, error: 'Home directory not found' };
      }

      if (appId == null) {
        return { exists: false, error: 'Failed to get Steam shortcut ID' };
      }

      const prefixPath = getProtonPrefixPath(appId);
      const exists = fs.existsSync(prefixPath);
      console.log(
        `[prefix] Checking prefix for appID ${appID}: ${exists ? 'exists' : 'not found'} at ${prefixPath}`
      );

      return { exists, prefixPath };
    })
  );

  // Add to Steam (updated to support UMU)
  ipcMain.handle(
    'app:add-to-steam',
    ipcBoundary(async (_, appID: number, oldSteamAppId: number | undefined) => {
      if (!isLinux()) {
        return { success: false, error: 'Only available on Linux' };
      }

      ensureLibraryDir();

      const appInfo = loadLibraryInfo(appID);
      if (!appInfo) {
        return { success: false, error: 'Game not found' };
      }

      // If this is a UMU game, use the new shortcut method
      if (appInfo.umu) {
        const result = await Effect.runPromise(
          addUmuGameToSteam({
            appID,
            name: appInfo.name,
            version: appInfo.version,
          })
        );

        if (result.success && result.steamAppId) {
          sendNotification({
            message: `Added ${appInfo.name} to Steam (UMU mode)`,
            id: generateNotificationId(),
            type: 'success',
          });
        }

        return result;
      }

      // Legacy mode (original behavior)
      let launchOptions = appInfo.launchArguments ?? '';

      // remove any wineprefix=..... from the launch options
      launchOptions = launchOptions.replace(/WINEPREFIX=\S*\s?/g, '').trim();

      // Format game name with version for unique Steam shortcut
      const versionedGameName = getVersionedGameName(
        appInfo.name,
        appInfo.version
      );

      // Use steamtinkerlaunch to add the game to steam
      const result = await Effect.runPromise(
        addGameToSteam({
          name: appInfo.name,
          version: appInfo.version,
          launchExecutable: appInfo.launchExecutable,
          cwd: appInfo.cwd,
          wrapperCommand: launchOptions || '%command%',
          appID,
          compatibilityTool: 'proton_experimental',
        })
      );

      if (!result) {
        return { success: false };
      }

      // Get the new Steam app ID after adding
      const newSteamAppId = await Effect.runPromise(
        getNonSteamGameAppID(versionedGameName).pipe(
          Effect.catchAll(() => Effect.succeed(undefined))
        )
      );

      if (!newSteamAppId) {
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

          if (!fs.existsSync(oldAppIdDir)) {
            sendNotification({
              message: 'Old prefix not found, skipping migration',
              id: generateNotificationId(),
              type: 'error',
            });
          } else if (fs.existsSync(newAppIdDir)) {
            console.warn(
              `[add-to-steam] New compatdata directory exists at ${newAppIdDir}`
            );
          } else {
            const migration = Effect.runSync(
              Effect.either(migrateCompatData(oldAppIdDir, newAppIdDir))
            );
            if (migration._tag === 'Left') {
              sendNotification({
                message: `Error migrating prefix: ${migration.left.message}`,
                id: generateNotificationId(),
                type: 'error',
              });
              shouldUpdateLaunchArguments = false;
              appInfo.launchArguments = originalLaunchArguments;
            } else {
              sendNotification({
                message: 'Successfully migrated prefix to new version.',
                id: generateNotificationId(),
                type: 'success',
              });
            }
          }
        }
      }

      // Update the library JSON with the new WINEPREFIX path only if migration succeeded or not needed
      if (shouldUpdateLaunchArguments) {
        const protonPath = getProtonPrefixPath(newSteamAppId);
        const normalizedLaunchOptions = launchOptions || '%command%';
        appInfo.launchArguments =
          'WINEPREFIX=' + protonPath + ' ' + normalizedLaunchOptions;
      }
      saveLibraryInfo(appID, appInfo);

      return { success: true };
    })
  );
}
