/**
 * Library CRUD IPC handlers
 * Updated to support UMU (Unified Launcher for Windows Games on Linux)
 */
import { ipcMain } from 'electron';
import { spawn, spawnSync } from 'child_process';
import type { LibraryInfo } from 'ogi-addon';
import { isLinux } from './helpers.app/platform.js';
import {
  getSteamAppIdWithFallback,
  getNonSteamGameAppID,
  getVersionedGameName,
  addGameToSteam,
} from './helpers.app/steam.js';
import { parse as shellQuoteParse } from 'shell-quote';
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
import {
  getProtonPrefixPath,
  getCurrentUsername,
} from './helpers.app/platform.js';
import * as fs from 'fs';
import {
  launchWithUmu,
  isUmuInstalled,
  installUmu,
  migrateToUmu,
  getUmuWinePrefix,
  buildDllOverrides,
  getEffectiveDllOverrides,
  getEffectiveLaunchEnv,
  parseLaunchArguments,
} from './handler.umu.js';
import { addUmuGameToSteam } from './handler.steam.js';

/**
 * Determine if a game should use UMU mode
 * - If game has `umu` config → use UMU
 */
async function shouldUseUmuMode(libraryInfo: LibraryInfo): Promise<boolean> {
  if (!isLinux()) return false;

  // Explicit UMU config
  if (libraryInfo.umu) return true;

  // No UMU config → use legacy mode (for backward compatibility)
  return false;
}

export type LaunchGameResult = {
  success: boolean;
  error?: string;
};

export type ExecuteWrapperResult = {
  success: boolean;
  exitCode?: number;
  signal?: string;
  error?: string;
};

export async function launchGameFromLibrary(
  appid: number | string,
  mainWindow?: Electron.BrowserWindow | null,
  launchEnv?: Record<string, string>
): Promise<LaunchGameResult> {
  console.log('[launch] Launching game', appid);
  ensureLibraryDir();
  ensureInternalsDir();

  const parsedAppId =
    typeof appid === 'number' ? appid : parseInt(String(appid), 10);
  if (Number.isNaN(parsedAppId)) {
    return { success: false, error: 'Invalid app ID' };
  }

  const appInfo = loadLibraryInfo(parsedAppId);
  if (!appInfo) {
    console.log('[launch] Game not found');
    return { success: false, error: 'Game not found' };
  }

  // Check if we should use UMU mode
  const useUmu = await shouldUseUmuMode(appInfo);

  if (useUmu) {
    console.log(`[launch] Using UMU mode for ${appInfo.name}`);

    const appID = appInfo.appID;
    const result = await launchWithUmu(appInfo, {
      onExit: () => {
        mainWindow?.webContents.send('game:exit', { id: appID });
      },
    });

    if (!result.success) {
      console.error('[launch] UMU launch failed:', result.error);
      sendNotification({
        message: `Failed to launch game: ${result.error}`,
        id: generateNotificationId(),
        type: 'error',
      });
      mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
      return {
        success: false,
        error: result.error ?? 'Failed to launch game with UMU',
      };
    }

    mainWindow?.webContents.send('game:launch', { id: appInfo.appID });
    return { success: true };
  }

  // Legacy mode
  const effectiveLaunchEnv = getEffectiveLaunchEnv(appInfo);
  const parsedArgs = parseLaunchArguments(appInfo.launchArguments);
  console.log(
    'Launching game:',
    appInfo.launchExecutable,
    parsedArgs,
    'in cwd:',
    appInfo.cwd
  );
  const spawnedItem = spawn(appInfo.launchExecutable, parsedArgs, {
    cwd: appInfo.cwd,
    shell: true,
    env: {
      ...process.env,
      ...(launchEnv ?? {}),
      ...effectiveLaunchEnv,
    },
  });
  spawnedItem.on('error', (error) => {
    console.error(error);
    sendNotification({
      message: 'Failed to launch game',
      id: generateNotificationId(),
      type: 'error',
    });
    mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
  });
  spawnedItem.on('exit', (exitCode, signal) => {
    console.log(
      'Game exited with code: ' +
        exitCode +
        (signal ? ` signal: ${signal}` : '')
    );
    if (exitCode !== 0 && exitCode != null) {
      sendNotification({
        message: 'Game Crashed',
        id: generateNotificationId(),
        type: 'error',
      });
    }
    mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
  });

  mainWindow?.webContents.send('game:launch', { id: appInfo.appID });
  return { success: true };
}

export async function executeWrapperCommandForApp(
  appid: number,
  wrapperCommand: string,
  type: 'steam-proton' | 'unknown',
  launchEnv?: Record<string, string>
): Promise<ExecuteWrapperResult> {
  if (type === 'steam-proton') {
    return executeWrapperCommandForAppSteam(appid, wrapperCommand, launchEnv);
  }
  return { success: false, error: 'Unsupported wrapper command type' };
}

async function executeWrapperCommandForAppSteam(
  appid: number,
  wrapperCommand: string,
  launchEnv?: Record<string, string>
): Promise<ExecuteWrapperResult> {
  ensureLibraryDir();

  const appInfo = loadLibraryInfo(appid);
  if (!appInfo) {
    return { success: false, error: 'Game not found' };
  }

  if (!wrapperCommand || wrapperCommand.trim().length === 0) {
    return { success: false, error: 'Wrapper command is empty' };
  }

  /* Built for Proton Steam */

  console.log(
    `[wrapper] Executing wrapper command for ${appInfo.name}: ${wrapperCommand}`
  );

  // Parse so paths with spaces aren't broken: split on the known verb first,
  // parse only the prefix (which may contain quoted paths), and treat
  // everything after the verb as a single path argument we replace with
  // appInfo.launchExecutable.
  const verb = 'waitforexitandrun';
  const verbWithSpaces = ` ${verb} `;
  const steamArgSeparator = ' -- ';
  const verbIndexInString = wrapperCommand.indexOf(verbWithSpaces);
  let parsed: ReturnType<typeof shellQuoteParse>;
  if (verbIndexInString !== -1) {
    const prefix = wrapperCommand.slice(0, verbIndexInString).trimEnd();
    parsed = shellQuoteParse(prefix);
    parsed.push(verb);
    // Everything after " waitforexitandrun " is the exe path (may contain spaces);
    // we replace it with the canonical path, so we don't parse the suffix.
  } else {
    parsed = shellQuoteParse(wrapperCommand);

    const firstToken =
      parsed.length > 0 && typeof parsed[0] === 'string' ? parsed[0] : '';
    const looksLikeCollapsedLauncher =
      firstToken.includes('steam-launch-wrapper') &&
      firstToken.includes(steamArgSeparator);
    if (looksLikeCollapsedLauncher) {
      const lastSeparatorInString =
        wrapperCommand.lastIndexOf(steamArgSeparator);
      if (lastSeparatorInString !== -1) {
        const prefix = wrapperCommand.slice(0, lastSeparatorInString).trimEnd();
        parsed = shellQuoteParse(prefix);
        parsed.push('--');
      }
    }
  }

  // Some Steam wrapper payloads arrive with a Proton executable path split
  // across tokens (for example: ".../common/Proton", "-", "Experimental/proton").
  // Recombine those segments so the wrapped launcher gets a valid executable path.
  const normalizeSplitProtonExecutable = (
    tokens: ReturnType<typeof shellQuoteParse>
  ): ReturnType<typeof shellQuoteParse> => {
    const normalized: ReturnType<typeof shellQuoteParse> = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (typeof token !== 'string') {
        normalized.push(token);
        continue;
      }

      const isSplitProtonStart =
        token.includes('/steamapps/common/Proton') &&
        !token.includes('/proton') &&
        !token.endsWith('/proton');

      if (!isSplitProtonStart) {
        normalized.push(token);
        continue;
      }

      let merged = token;
      let j = i + 1;
      while (j < tokens.length) {
        const next = tokens[j];
        if (typeof next !== 'string' || next === '--' || next === verb) {
          break;
        }
        merged += ` ${next}`;
        j += 1;
        if (merged.includes('/proton') || merged.endsWith('/proton')) {
          break;
        }
      }

      normalized.push(merged);
      i = j - 1;
    }

    return normalized;
  };

  parsed = normalizeSplitProtonExecutable(parsed);

  if (parsed.length === 0) {
    return { success: false, error: 'Wrapper command could not be parsed' };
  }
  const verbIndex = parsed.findIndex((x) => x === verb);
  const fixedArgs =
    verbIndex === -1
      ? [...parsed, appInfo.launchExecutable]
      : [...parsed.slice(0, verbIndex + 1), appInfo.launchExecutable];

  return await new Promise((resolve) => {
    const effectiveLaunchEnv = getEffectiveLaunchEnv(appInfo);
    const effectiveDllOverrides = getEffectiveDllOverrides(appInfo);
    const dllOverrideString = buildDllOverrides(effectiveDllOverrides);
    const baseEnv = {
      ...process.env,
      ...(launchEnv ?? {}),
      ...effectiveLaunchEnv,
      PROTON_LOG: '1',
    };
    const env = appInfo.umu
      ? {
          ...baseEnv,
          STEAM_COMPAT_DATA_PATH: getUmuWinePrefix(appInfo.umu.umuId),
          WINEPREFIX: getUmuWinePrefix(appInfo.umu.umuId),
          ...(dllOverrideString ? { WINEDLLOVERRIDES: dllOverrideString } : {}),
        }
      : baseEnv;

    const wrappedChild = spawn(
      parsed[0].toString(),
      fixedArgs.slice(1).map((x) => x.toString()),
      {
        shell: true,
        cwd: appInfo.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    wrappedChild.stdout?.on('data', (data) => {
      console.log(`[wrapper stdout] ${data}`);
    });

    wrappedChild.stderr?.on('data', (data) => {
      console.error(`[wrapper stderr] ${data}`);
    });

    wrappedChild.on('error', (error) => {
      console.error('[wrapper] Failed to execute wrapper command:', error);
      resolve({ success: false, error: error.message });
    });

    wrappedChild.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ success: true, exitCode: 0 });
        return;
      }

      const error = `Wrapped command exited with code ${code ?? 'null'}${signal ? ` (signal: ${signal})` : ''}`;
      console.error(`[wrapper] ${error}`);
      resolve({
        success: false,
        error,
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
      });
    });
  });
}

export function registerLibraryHandlers(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('app:launch-game', async (_, appid) => {
    const result = await launchGameFromLibrary(appid, mainWindow);
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to launch game');
    }
  });

  ipcMain.handle(
    'app:execute-wrapper-command',
    async (
      _,
      appid: number,
      wrapperCommand: string
    ): Promise<ExecuteWrapperResult> =>
      executeWrapperCommandForAppSteam(appid, wrapperCommand)
  );

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

      // Check if UMU is available and should be used (Linux only; macOS uses legacy)
      const umuAvailable = isLinux();
      const isDeckUser =
        isLinux() && getCurrentUsername()?.toLowerCase() === 'deck';

      if (umuAvailable && data.umu) {
        console.log('[setup] Using UMU mode for new game');

        // Ensure UMU is installed (if not, try to install)
        if (!(await isUmuInstalled())) {
          sendNotification({
            message: 'Installing UMU...',
            id: generateNotificationId(),
            type: 'info',
          });
          const installResult = await installUmu();
          if (!installResult.success) {
            console.error(
              '[setup] UMU auto-install failed:',
              installResult.error
            );
            sendNotification({
              message: 'Failed to install UMU',
              id: generateNotificationId(),
              type: 'error',
            });
            data.umu = undefined;
            return 'setup-failed';
          }
        }

        // Set up UMU-specific paths only when UMU is still configured (install succeeded or was already present)
        if (data.umu) {
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

          // On Steam Deck (user "deck"), add a Steam shortcut so the game appears in Game Mode
          if (isDeckUser) {
            const steamResult = await addUmuGameToSteam({
              appID: data.appID,
              name: data.name,
              version: data.version,
            });
            if (!steamResult.success) {
              console.warn(
                '[setup] Failed to add UMU game to Steam for Deck:',
                steamResult.error
              );
            }
          }

          if (data.redistributables && data.redistributables.length > 0) {
            console.log(
              '[setup] Redistributables detected, need to install them for:',
              data.name
            );
            return 'setup-prefix-required';
          }
          return 'setup-success';
        }
      }

      // Linux if not using UMU (legacy mode)
      saveLibraryInfo(data.appID, data);
      addToInternalsApps(data.appID);

      // linux case (legacy)
      if (isLinux()) {
        // make the launch executable use / instead of \
        data.launchExecutable = data.launchExecutable.replace(/\\/g, '/');

        // Add game to Steam first via steamtinkerlaunch
        const launchOptions = data.launchArguments ?? '';

        // Format game name with version for unique Steam shortcut
        const versionedGameName = getVersionedGameName(data.name, data.version);

        const result = await addGameToSteam({
          name: versionedGameName,
          version: data.version,
          launchExecutable: data.launchExecutable,
          cwd: data.cwd,
          wrapperCommand: launchOptions || '%command%',
          appID: data.appID,
          compatibilityTool: 'proton_experimental',
        });

        // add to the {appid}.json file the launch options
        const { success, appId: steamAppId } =
          await getNonSteamGameAppID(versionedGameName);
        if (!success) {
          return 'setup-failed';
        }
        const protonPath = getProtonPrefixPath(steamAppId!);
        const normalizedLaunchOptions = launchOptions || '%command%';
        data.launchArguments =
          'WINEPREFIX=' + protonPath + ' ' + normalizedLaunchOptions;

        saveLibraryInfo(data.appID, data);

        if (!result) {
          return 'setup-failed';
        }

        // Check if this is a Windows executable (.exe)
        // If so, UMU will automatically create the prefix and handle redistributables
        const isWindowsExecutable = data.launchExecutable
          .toLowerCase()
          .endsWith('.exe');

        if (isWindowsExecutable) {
          console.log(
            '[setup] Windows executable (.exe) detected. UMU will create the prefix using Steam App ID from steamtinkerlaunch.'
          );

          if (data.redistributables && data.redistributables.length > 0) {
            console.log(
              '[setup] Redistributables also detected. Returning setup-prefix-required status.'
            );

            // Re-save the data with redistributables preserved for later installation
            saveLibraryInfo(data.appID, data);

            return 'setup-prefix-required';
          }

          // Even without redistributables, the prefix will be created on first launch
          console.log(
            '[setup] Prefix will be created automatically on first game launch via UMU.'
          );
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
        launchEnv?: LibraryInfo['launchEnv'];
      }
    ) => {
      const appData = loadLibraryInfo(data.appID);
      if (!appData) {
        return 'app-not-found';
      }

      if (data.addonSource) {
        appData.addonsource = data.addonSource;
      }

      // Capture old version before updating for migration lookup
      const oldVersion = appData.version;

      appData.version = data.version;
      appData.cwd = data.cwd;
      appData.launchExecutable = data.launchExecutable;
      if (data.launchEnv !== undefined) {
        appData.launchEnv = data.launchEnv;
      }

      // Handle UMU config if provided
      const prevUmu = appData.umu;
      if (data.umu) {
        appData.umu = data.umu;
        // Update wine prefix path
        appData.umu.winePrefixPath = getUmuWinePrefix(data.umu.umuId);

        // Check if we need to migrate from legacy mode (first-time UMU or coming from legacy)
        if (prevUmu === undefined) {
          console.log('[update] Migrating game from legacy to UMU mode');

          // Get the old Steam app ID for migration (use old version)
          const { success, appId: oldSteamAppId } =
            await getSteamAppIdWithFallback(
              appData.name,
              oldVersion,
              'migration'
            );

          if (!success || !oldSteamAppId) {
            console.warn(
              '[update] Could not detect old Steam app ID during migration. Falling back to UMU prefix initialization.'
            );
          }

          const migrationResult = await migrateToUmu(data.appID, oldSteamAppId);
          if (!migrationResult.success) {
            console.warn('[update] Migration failed:', migrationResult.error);
            // Continue anyway - UMU will create a fresh prefix
          }
        }
      }

      // On Linux, handle legacy mode updates
      if (isLinux() && prevUmu === undefined) {
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

  ipcMain.handle('app:get-library-info', async (_, appID: number) => {
    return loadLibraryInfo(appID);
  });
}
