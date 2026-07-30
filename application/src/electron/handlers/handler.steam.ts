/**
 * Steam-related IPC handlers
 * Updated to support UMU shortcuts and --game-id launch
 */

import { FileSystemError, formatError, ipcBoundary } from '@ogi/errors';
import { exec, execFile, spawn } from 'child_process';
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
  getSteamAppIdWithFallback,
  getVersionedGameName,
  removeGameFromSteam,
} from '@/electron/handlers/helpers.app/steam.js';
import { getNonSteamLaunchId } from '@/electron/lib/steam-vdf.js';
import { sendNotification } from '@/electron/main.js';

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
    });

    if (!result) {
      return { success: false, error: 'Failed to add game to Steam' };
    }

    const steamAppId = yield* getSteamAppIdWithFallback(
      params.name,
      params.version,
      'addGameToSteam'
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    if (steamAppId) {
      appInfo.umu.steamShortcutId = steamAppId;
      saveLibraryInfo(params.appID, appInfo);
    }

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
    const launchId = getNonSteamLaunchId(appId);
    execFile('xdg-open', [`steam://rungameid/${launchId}`], (error) => {
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
 * This does not modify Steam and is useful for desktop environments.
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
    ipcBoundary((_, appID: number) =>
      Effect.gen(function* () {
        if (!isLinux()) {
          return { success: false, error: 'Only available on Linux' };
        }
        let appInfo = loadLibraryInfo(appID);
        if (!appInfo) {
          return { success: false, error: 'Game not found' };
        }
        return yield* getSteamAppIdWithFallback(
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
        );
      })
    )
  );

  // Kill Steam process
  ipcMain.handle(
    'app:kill-steam',
    ipcBoundary(() =>
      Effect.gen(function* () {
        if (!isLinux()) {
          return { success: false, error: 'Only available on Linux' };
        }
        console.log('[steam] Attempting to kill Steam process...');
        yield* Effect.async<void, never>((resume) => {
          exec('steam -shutdown', (error) => {
            if (error) {
              exec('killall steam', (error2) => {
                if (error2) {
                  console.log('[steam] No Steam process found to kill');
                } else {
                  console.log('[steam] Steam process killed via killall');
                }
                resume(Effect.void);
              });
            } else {
              console.log('[steam] Steam process killed via pkill');
              resume(Effect.void);
            }
          });
        });
        return { success: true };
      })
    )
  );

  // Start Steam
  ipcMain.handle(
    'app:start-steam',
    ipcBoundary(() =>
      Effect.gen(function* () {
        if (!isLinux()) {
          return { success: false, error: 'Only available on Linux' };
        }
        console.log('[steam] Starting Steam...');
        const result = yield* Effect.async<
          { success: boolean; error?: string },
          never
        >((resume) => {
          const child = spawn('steam', [], { detached: true, stdio: 'ignore' });
          child.unref();
          let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
            console.log('[steam] Steam launch command executed');
            timeoutId = null;
            resume(Effect.succeed({ success: true }));
          }, 1000);
          child.on('error', (error) => {
            console.error('[steam] Failed to start Steam:', error);
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            resume(Effect.succeed({ success: false, error: error.message }));
          });
          child.on('exit', (code) => {
            if (code !== 0 && code !== null) {
              console.error(`[steam] Steam process exited with code ${code}`);
              if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
              resume(
                Effect.succeed({
                  success: false,
                  error: `Steam process exited with code ${code}`,
                })
              );
            }
          });
        });
        return result;
      })
    )
  );

  // Launch Steam app (legacy - for backward compatibility)
  ipcMain.handle(
    'app:launch-steam-app',
    ipcBoundary((_, appID: number) =>
      Effect.gen(function* () {
        if (!isLinux()) {
          return { success: false, error: 'Only available on Linux' };
        }
        let appInfo = loadLibraryInfo(appID);
        if (!appInfo) {
          return { success: false, error: 'Game not found' };
        }
        if (
          !appInfo.umu &&
          appInfo.launchExecutable.toLowerCase().endsWith('.exe')
        ) {
          const detectedSteamAppId = yield* getSteamAppIdWithFallback(
            appInfo.name,
            appInfo.version,
            'launch-steam-migration'
          ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
          const migration = yield* Effect.tryPromise({
            try: async () => {
              const { migrateToUmu } = await import(
                '@/electron/handlers/handler.umu.js'
              );
              return migrateToUmu(appID, detectedSteamAppId);
            },
            catch: (cause) => new Error(formatError(cause)),
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed({ success: false, error: error.message })
            )
          );
          if (!migration.success) return migration;
          appInfo = loadLibraryInfo(appID);
          if (!appInfo)
            return {
              success: false,
              error: 'Game disappeared during migration',
            };
        }
        if (appInfo.umu) {
          let appId = yield* getSteamAppIdWithFallback(
            appInfo.name,
            appInfo.version,
            'steam'
          ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
          if (!appId) {
            const result = yield* addUmuGameToSteam({
              appID,
              name: appInfo.name,
              version: appInfo.version,
            });
            if (!result.success) return result;
            appId = yield* getSteamAppIdWithFallback(
              appInfo.name,
              appInfo.version,
              'steam'
            ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
          }
          if (!appId) {
            return { success: false, error: 'Failed to get Steam shortcut ID' };
          }
          return yield* launchViaSteam(appId);
        }
        const appId = yield* getSteamAppIdWithFallback(
          appInfo.name,
          appInfo.version,
          'steam'
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        if (appId == null) {
          return { success: false, error: 'Failed to get Steam shortcut ID' };
        }
        console.log(
          `[steam] Launching app via Steam: ${appInfo.name} (shortcut ID: ${appId})`
        );
        return yield* launchViaSteam(appId);
      })
    )
  );
  // Check if prefix exists (legacy - for backward compatibility)
  ipcMain.handle(
    'app:check-prefix-exists',
    ipcBoundary((_, appID: number) =>
      Effect.gen(function* () {
        if (!isLinux()) {
          return { exists: false, error: 'Only available on Linux' };
        }
        const libraryInfo = loadLibraryInfo(appID);
        if (!libraryInfo) {
          return { exists: false, error: 'Game not found' };
        }
        if (libraryInfo.umu?.winePrefixPath) {
          const exists = fs.existsSync(libraryInfo.umu.winePrefixPath);
          return { exists, prefixPath: libraryInfo.umu.winePrefixPath };
        }
        const appId = yield* getSteamAppIdWithFallback(
          libraryInfo.name,
          libraryInfo.version,
          'prefix'
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
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
    )
  );

  // Add to Steam (updated to support UMU)
  ipcMain.handle(
    'app:add-to-steam',
    ipcBoundary((_, appID: number, oldSteamAppId: number | undefined) =>
      Effect.gen(function* () {
        if (!isLinux()) {
          return { success: false, error: 'Only available on Linux' };
        }
        ensureLibraryDir();
        let appInfo = loadLibraryInfo(appID);
        if (!appInfo) {
          return { success: false, error: 'Game not found' };
        }
        if (
          !appInfo.umu &&
          appInfo.launchExecutable.toLowerCase().endsWith('.exe')
        ) {
          const detectedSteamAppId = yield* getSteamAppIdWithFallback(
            appInfo.name,
            appInfo.version,
            'add-to-steam-migration'
          ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
          const migration = yield* Effect.tryPromise({
            try: async () => {
              const { migrateToUmu } = await import(
                '@/electron/handlers/handler.umu.js'
              );
              return migrateToUmu(appID, oldSteamAppId || detectedSteamAppId);
            },
            catch: (cause) => new Error(formatError(cause)),
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed({ success: false, error: error.message })
            )
          );
          if (!migration.success) return migration;
          appInfo = loadLibraryInfo(appID);
          if (!appInfo)
            return {
              success: false,
              error: 'Game disappeared during migration',
            };
        }
        if (appInfo.umu) {
          const result = yield* addUmuGameToSteam({
            appID,
            name: appInfo.name,
            version: appInfo.version,
          });
          if (result.success && result.steamAppId) {
            sendNotification({
              message: `Added ${appInfo.name} to Steam (UMU mode)`,
              id: generateNotificationId(),
              type: 'success',
            });
          }
          return result;
        }
        const result = yield* addGameToSteam({
          name: appInfo.name,
          version: appInfo.version,
          launchExecutable: appInfo.launchExecutable,
          cwd: appInfo.cwd,
          wrapperCommand: appInfo.launchArguments || '%command%',
          appID,
        });
        if (!result) {
          return { success: false };
        }
        return { success: result };
      })
    )
  );

  ipcMain.handle(
    'app:remove-from-steam',
    ipcBoundary((_, appID: number) =>
      Effect.gen(function* () {
        const appInfo = loadLibraryInfo(appID);
        if (!appInfo) return { success: false, error: 'Game not found' };
        const removed = yield* removeGameFromSteam(
          appInfo.name,
          appInfo.version
        );
        return removed
          ? { success: true }
          : { success: false, error: 'Shortcut not found or Steam is running' };
      })
    )
  );
}
