/**
 * UMU (Unified Launcher for Windows Games on Linux) IPC handlers
 * Replaces the legacy Steam/flatpak wine system with UMU Launcher
 */
import { ipcMain } from 'electron';
import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { LibraryInfo } from 'ogi-addon';
import { isLinux, getHomeDir } from './helpers.app/platform.js';
import { loadLibraryInfo, saveLibraryInfo } from './helpers.app/library.js';
import { generateNotificationId } from './helpers.app/notifications.js';
import { sendNotification } from '../main.js';
import { __dirname } from '../manager/manager.paths.js';
const execAsync = promisify(exec);

/**
 * Get the UMU prefix base directory
 * Throws an error if home directory cannot be determined
 */
function getUmuPrefixBase(): string {
  const home = getHomeDir();
  if (!home) {
    throw new Error('Cannot determine home directory for UMU prefix base');
  }
  return path.join(home, '.ogi-wine-prefixes');
}

const umuRunExecutable = path.join(__dirname, 'bin', 'umu', 'umu-run');
/**
 * Check if UMU is installed on the system
 */
export async function isUmuInstalled(): Promise<boolean> {
  try {
    if (fs.existsSync(umuRunExecutable)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const UMU_RELEASES_URL =
  'https://api.github.com/repos/Open-Wine-Components/umu-launcher/releases/latest';
const UMU_BIN_DIR = path.join(__dirname, 'bin', 'umu');

/**
 * Auto-install UMU launcher.
 * Fetches the latest release from GitHub, downloads the zipapp tarball,
 * extracts it to bin/umu/, then verifies umu-run exists.
 */
export async function installUmu(): Promise<{
  success: boolean;
  error?: string;
}> {
  console.log('[umu] Installing UMU launcher...');

  let zipappPath: string | null = null;

  try {
    // 1. Fetch latest release and find zipapp asset
    const releaseRes = await fetch(UMU_RELEASES_URL);
    if (!releaseRes.ok) {
      return {
        success: false,
        error: `GitHub API failed: ${releaseRes.status} ${releaseRes.statusText}`,
      };
    }
    const release = (await releaseRes.json()) as {
      assets?: Array<{ name: string; browser_download_url: string }>;
    };
    const assets = release?.assets ?? [];
    const zipappAsset = assets.find((a) => a.name.includes('-zipapp.tar'));
    if (!zipappAsset?.browser_download_url) {
      return {
        success: false,
        error: 'No zipapp tarball found in latest release',
      };
    }

    // 2. Ensure bin/umu exists and resolve tar path
    if (!fs.existsSync(UMU_BIN_DIR)) {
      fs.mkdirSync(UMU_BIN_DIR, { recursive: true });
    }
    zipappPath = path.join(UMU_BIN_DIR, 'umu-launcher-zipapp.tar');

    // 3. Download zipapp tarball
    const downloadRes = await fetch(zipappAsset.browser_download_url);
    if (!downloadRes.ok) {
      return {
        success: false,
        error: `Download failed: ${downloadRes.status} ${downloadRes.statusText}`,
      };
    }
    const arrayBuffer = await downloadRes.arrayBuffer();
    fs.writeFileSync(zipappPath, Buffer.from(arrayBuffer));

    // 4. Extract tarball into bin/umu
    await execAsync(`tar -xvf ${zipappPath} -C ${UMU_BIN_DIR}`);

    // 5. Flatten: tarball may have a single top-level dir (e.g. "umu") — move contents up
    const entries = fs.readdirSync(UMU_BIN_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 1) {
      const innerDir = path.join(UMU_BIN_DIR, dirs[0].name);
      for (const e of fs.readdirSync(innerDir, { withFileTypes: true })) {
        const src = path.join(innerDir, e.name);
        const dest = path.join(UMU_BIN_DIR, e.name);
        fs.renameSync(src, dest);
      }
      fs.rmdirSync(innerDir);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  } finally {
    if (zipappPath != null && fs.existsSync(zipappPath)) {
      try {
        fs.unlinkSync(zipappPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }

  if (!fs.existsSync(umuRunExecutable)) {
    return { success: false, error: 'UMU run binary not found after extract' };
  }
  return { success: true };
}

/**
 * Convert UMU ID format to GAMEID environment variable value
 * - 'steam:12345' → 'umu-12345'
 * - 'umu:67890' → 'umu-67890'
 */
export function convertUmuId(umuId: string): string {
  if (umuId.startsWith('steam:')) {
    return `umu-${umuId.substring(6)}`;
  }
  if (umuId.startsWith('umu:')) {
    return `umu-${umuId.substring(4)}`;
  }
  // Fallback: assume it's already in the correct format
  return umuId;
}

/**
 * Get the WINEPREFIX path for a game
 */
export function getUmuWinePrefix(gameId: string): string {
  const gameIdClean = convertUmuId(gameId).replace('umu-', '');
  return path.join(getUmuPrefixBase(), `umu-${gameIdClean}`);
}

/**
 * Ensure UMU prefix base directory exists
 */
export function ensureUmuPrefixBase(): void {
  const prefixBase = getUmuPrefixBase();
  if (!fs.existsSync(prefixBase)) {
    fs.mkdirSync(prefixBase, { recursive: true });
  }
}

/**
 * Build WINEDLLOVERRIDES string from dllOverrides array
 * Wine expects DLL names without the .dll extension (e.g., "dinput8=n,b")
 */
export function buildDllOverrides(dllOverrides: string[]): string {
  if (!dllOverrides || dllOverrides.length === 0) {
    return '';
  }

  // Build the override string: "dll1=n,b;dll2=n,b"
  // Each DLL gets "n,b" (native first, then builtin)
  // Wine expects DLL names without the .dll extension
  const overrides = dllOverrides.map((dll) => {
    // Get basename and strip .dll extension
    const dllName = path.basename(dll).replace(/\.dll$/i, '');
    return `${dllName}=n,b`;
  });

  return overrides.join(';');
}

/**
 * Launch a game using UMU
 */
export async function launchWithUmu(
  libraryInfo: LibraryInfo
): Promise<{ success: boolean; error?: string; pid?: number }> {
  if (!isLinux()) {
    return { success: false, error: 'UMU is only available on Linux' };
  }

  if (!libraryInfo.umu) {
    return { success: false, error: 'No UMU configuration found' };
  }

  // Ensure UMU is installed
  const umuInstalled = await isUmuInstalled();
  if (!umuInstalled) {
    console.log('[umu] UMU not found, attempting auto-install...');
    const installResult = await installUmu();
    if (!installResult.success) {
      return {
        success: false,
        error: `UMU not installed and auto-install failed: ${installResult.error}`,
      };
    }
  }

  ensureUmuPrefixBase();

  const { umuId, dllOverrides, protonVersion, store } = libraryInfo.umu;
  const gameId = convertUmuId(umuId);
  const winePrefix = getUmuWinePrefix(umuId);

  // Build environment variables
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GAMEID: gameId,
    WINEPREFIX: winePrefix,
  };

  if (protonVersion) {
    env.PROTONPATH = protonVersion;
  } else {
    env.PROTONPATH = 'UMU-Latest';
  }

  if (store) {
    env.STORE = store;
  }

  // Build DLL overrides
  if (dllOverrides && dllOverrides.length > 0) {
    const dllOverrideStr = buildDllOverrides(dllOverrides);
    if (dllOverrideStr) {
      env.WINEDLLOVERRIDES = dllOverrideStr;
    }
  }

  // Build launch arguments. Remove the %command% placeholder as we handle everything now for exe.
  const launchArgs = (libraryInfo.launchArguments || '').replace(
    '%command%',
    ''
  );
  const exePath = libraryInfo.launchExecutable;
  const parsedLaunchArgs =
    launchArgs
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((arg) => arg.replace(/^['"]|['"]$/g, '')) ?? [];

  console.log('[umu] Launching game:', {
    name: libraryInfo.name,
    gameId,
    winePrefix,
    protonVersion: protonVersion,
    store: store || 'none',
    hasDllOverrides: !!dllOverrides && dllOverrides.length > 0,
    environment: env,
  });

  return new Promise((resolve) => {
    console.log("[umu] command i'm running: ", umuRunExecutable, [
      exePath,
      ...parsedLaunchArgs.join(' '),
    ]);
    const child = spawn(
      umuRunExecutable,
      [exePath, ...parsedLaunchArgs.join(' ')],
      {
        cwd: libraryInfo.cwd,
        env: {
          ...env,
          GAMEID: gameId,
          WINEPREFIX: winePrefix,
          PROTONPATH: protonVersion || 'UMU-Latest',
          STORE: store || 'none',
          WINEDLLOVERRIDES: buildDllOverrides(dllOverrides || []),
          PROTON_DISABLE_LSTEAMCLIENT: '1',
          PWD: libraryInfo.cwd,
          UMU_LOG: 'debug',
          // target steam game mode
          DISPLAY: ':0',
          WAYLAND_DISPLAY: 'wayland-0',
          XDG_RUNTIME_DIR: '/run/user/1000',
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.unref();

    child.stdout?.on('data', (data) => {
      console.log(`[umu stdout] ${data}`);
    });

    child.stderr?.on('data', (data) => {
      console.error(`[umu stderr] ${data}`);
    });

    let processExited = false;

    child.on('error', (error) => {
      if (!processExited) {
        processExited = true;
        console.error('[umu] Failed to launch game:', error);
        resolve({ success: false, error: error.message });
      }
    });

    child.on('exit', (code, signal) => {
      if (!processExited) {
        processExited = true;
        if (code === 0) {
          console.log(`[umu] Game process exited normally with code ${code}`);
          resolve({ success: true, pid: child.pid });
        } else {
          console.error(
            `[umu] Game process exited abnormally, code: ${code}, signal: ${signal}`
          );
          resolve({
            success: false,
            error: `Exited with code ${code}, signal ${signal}`,
            pid: child.pid,
          });
        }
      }
    });
  });
}

/**
 * Install redistributables using UMU winetricks
 */
export async function installRedistributablesWithUmu(
  appID: number
): Promise<'success' | 'failed' | 'not-found'> {
  if (!isLinux()) {
    return 'failed';
  }

  const libraryInfo = loadLibraryInfo(appID);
  if (!libraryInfo) {
    return 'not-found';
  }

  // Check if this is a legacy game
  if (libraryInfo.legacyMode) {
    console.log('[umu] Legacy mode game, skipping UMU redistributables');
    return 'failed';
  }

  if (!libraryInfo.umu && !libraryInfo.redistributables) {
    console.log('[umu] No redistributables to install');
    return 'success';
  }

  // Ensure UMU is installed
  const umuInstalled = await isUmuInstalled();
  if (!umuInstalled) {
    const installResult = await installUmu();
    if (!installResult.success) {
      return 'failed';
    }
  }

  ensureUmuPrefixBase();

  const { umuId, protonVersion } = libraryInfo.umu || {};
  const gameId = umuId ? convertUmuId(umuId) : 'umu-default';
  const winePrefix = umuId
    ? getUmuWinePrefix(umuId)
    : path.join(getUmuPrefixBase(), 'umu-default');

  const redistributables = libraryInfo.redistributables || [];

  console.log(
    `[umu] Installing ${redistributables.length} redistributables for ${libraryInfo.name}`
  );

  let anyFailed = false;
  for (const redistributable of redistributables) {
    try {
      sendNotification({
        message: `Installing ${redistributable.name} for ${libraryInfo.name}`,
        id: generateNotificationId(),
        type: 'info',
      });

      const success = await new Promise<boolean>((resolve) => {
        let resolved = false;
        const finalize = (result: boolean) => {
          if (resolved) return;
          resolved = true;
          resolve(result);
        };

        const env: NodeJS.ProcessEnv = {
          ...process.env,
          GAMEID: gameId,
          WINEPREFIX: winePrefix,
          UMU_LOG: 'debug',
        };

        if (protonVersion) {
          env.PROTONPATH = protonVersion;
        }

        let child;

        if (redistributable.path === 'winetricks') {
          // Use winetricks verb
          child = spawn(
            umuRunExecutable,
            ['winetricks', redistributable.name],
            {
              env: {
                UMU_LOG: 'debug',
                GAMEID: gameId,
                WINEPREFIX: winePrefix,
                PROTONPATH: protonVersion || 'UMU-Latest',
                PWD: libraryInfo.cwd,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
        } else if (
          redistributable.path === 'microsoft' &&
          redistributable.name === 'dotnet-repair'
        ) {
          // Special case for .NET repair tool
          // This would need to be downloaded and run
          console.log('[umu] .NET repair tool not yet implemented for UMU');
          finalize(false);
          return;
        } else {
          // Regular redistributable file
          const redistPath = path.resolve(redistributable.path);
          if (!fs.existsSync(redistPath)) {
            console.error('[umu] Redistributable not found:', redistPath);
            finalize(false);
            return;
          }

          const redistDir = path.dirname(redistPath);
          const redistFile = path.basename(redistPath);

          // Determine silent install flags
          const silentFlags = getSilentInstallFlags(redistFile);

          child = spawn(umuRunExecutable, [redistFile, ...silentFlags], {
            env: {
              ...env,
              GAMEID: gameId,
              WINEPREFIX: winePrefix,
              PROTONPATH: protonVersion || 'UMU-Latest',
              PWD: libraryInfo.cwd,
              UMU_LOG: 'debug',
            },
            cwd: redistDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }

        const timeout = setTimeout(
          () => {
            if (child.pid) {
              child.kill('SIGTERM');
            }
            finalize(false);
          },
          10 * 60 * 1000
        ); // 10 minute timeout

        child.on(
          'close',
          (code: number | null, signal: NodeJS.Signals | null) => {
            clearTimeout(timeout);
            const success = code === 0 && signal == null && !!child.pid;
            if (!success && signal != null) {
              console.error(
                `[umu] Redistributable process killed by signal: ${signal}`
              );
            }
            finalize(success);
          }
        );

        child.on('error', (error) => {
          clearTimeout(timeout);
          console.error('[umu] Redistributable error:', error);
          finalize(false);
        });
      });

      if (success) {
        sendNotification({
          message: `Installed ${redistributable.name} for ${libraryInfo.name}`,
          id: generateNotificationId(),
          type: 'success',
        });
      } else {
        anyFailed = true;
        sendNotification({
          message: `Failed to install ${redistributable.name} for ${libraryInfo.name}`,
          id: generateNotificationId(),
          type: 'error',
        });
      }
    } catch (error) {
      anyFailed = true;
      console.error(`[umu] Error installing ${redistributable.name}:`, error);
      sendNotification({
        message: `Failed to install ${redistributable.name} for ${libraryInfo.name}`,
        id: generateNotificationId(),
        type: 'error',
      });
    }
  }

  // Clear redistributables from the library file only when all succeeded (so retries remain possible on failure)
  if (!anyFailed) {
    const updatedInfo = loadLibraryInfo(appID);
    if (updatedInfo) {
      delete updatedInfo.redistributables;
      saveLibraryInfo(appID, updatedInfo);
    }
  }

  sendNotification({
    message: anyFailed
      ? `Finished installing redistributables for ${libraryInfo.name} (some failed)`
      : `Finished installing redistributables for ${libraryInfo.name}`,
    id: generateNotificationId(),
    type: anyFailed ? 'warning' : 'success',
  });

  return anyFailed ? 'failed' : 'success';
}

/**
 * Install redistributables for legacy games using UMU with Steam prefix
 * This creates the prefix at the Steam compatdata location using UMU
 */
export async function installRedistributablesWithUmuForLegacy(
  appID: number,
  steamAppId: number
): Promise<'success' | 'failed' | 'not-found'> {
  if (!isLinux()) {
    return 'failed';
  }

  const libraryInfo = loadLibraryInfo(appID);
  if (!libraryInfo) {
    return 'not-found';
  }

  if (
    !libraryInfo.redistributables ||
    libraryInfo.redistributables.length === 0
  ) {
    console.log('[umu-legacy] No redistributables to install');
    return 'success';
  }

  // Ensure UMU is installed
  const umuInstalled = await isUmuInstalled();
  if (!umuInstalled) {
    console.log('[umu-legacy] UMU not found, attempting auto-install...');
    const installResult = await installUmu();
    if (!installResult.success) {
      console.error(
        '[umu-legacy] UMU auto-install failed:',
        installResult.error
      );
      return 'failed';
    }
  }

  // Get the Steam compatdata prefix path
  const homeDir = getHomeDir();
  if (!homeDir) {
    console.error('[umu-legacy] Cannot determine home directory');
    return 'failed';
  }

  const winePrefix = path.join(
    homeDir,
    '.steam',
    'steam',
    'steamapps',
    'compatdata',
    steamAppId.toString()
  );

  // Create the prefix directory if it doesn't exist
  if (!fs.existsSync(winePrefix)) {
    console.log('[umu-legacy] Creating Steam prefix directory:', winePrefix);
    fs.mkdirSync(winePrefix, { recursive: true });
  }

  // Use UMU to initialize the prefix first
  console.log('[umu-legacy] Initializing prefix with UMU:', winePrefix);
  sendNotification({
    message: `Initializing Wine prefix for ${libraryInfo.name}`,
    id: generateNotificationId(),
    type: 'info',
  });

  const initSuccess = await new Promise<boolean>((resolve) => {
    const initChild = spawn(
      umuRunExecutable,
      ['wine', 'cmd', '/c', 'echo', 'Prefix initialized'],
      {
        env: {
          UMU_LOG: 'debug',
          GAMEID: `umu-${steamAppId}`,
          WINEPREFIX: winePrefix,
          PROTONPATH: 'UMU-Latest',
          PWD: libraryInfo.cwd,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    const timeout = setTimeout(
      () => {
        if (initChild.pid) {
          initChild.kill('SIGTERM');
        }
        resolve(false);
      },
      5 * 60 * 1000
    ); // 5 minute timeout for prefix init

    initChild.on('close', (code: number | null) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });

    initChild.on('error', (error) => {
      clearTimeout(timeout);
      console.error('[umu-legacy] Prefix init error:', error);
      resolve(false);
    });
  });

  if (!initSuccess) {
    console.error('[umu-legacy] Failed to initialize prefix');
    return 'failed';
  }

  console.log('[umu-legacy] Prefix initialized successfully');

  // Now install redistributables using UMU winetricks
  const redistributables = libraryInfo.redistributables;
  let anyFailed = false;

  for (const redistributable of redistributables) {
    try {
      sendNotification({
        message: `Installing ${redistributable.name} for ${libraryInfo.name}`,
        id: generateNotificationId(),
        type: 'info',
      });

      console.log('[umu-legacy] Installing:', redistributable.name);

      const success = await new Promise<boolean>((resolve) => {
        let resolved = false;
        const finalize = (result: boolean) => {
          if (resolved) return;
          resolved = true;
          resolve(result);
        };

        let child;

        if (redistributable.path === 'winetricks') {
          // Use winetricks verb via UMU
          child = spawn(
            umuRunExecutable,
            ['winetricks', redistributable.name],
            {
              env: {
                UMU_LOG: 'debug',
                GAMEID: `umu-${steamAppId}`,
                WINEPREFIX: winePrefix,
                PROTONPATH: 'UMU-Latest',
                PWD: libraryInfo.cwd,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
        } else {
          // Regular redistributable file - run with UMU
          const redistPath = path.resolve(redistributable.path);
          if (!fs.existsSync(redistPath)) {
            console.error(
              '[umu-legacy] Redistributable not found:',
              redistPath
            );
            finalize(false);
            return;
          }

          const redistDir = path.dirname(redistPath);
          const redistFile = path.basename(redistPath);
          const silentFlags = getSilentInstallFlags(redistFile);

          child = spawn(umuRunExecutable, [redistFile, ...silentFlags], {
            env: {
              UMU_LOG: 'debug',
              GAMEID: `umu-${steamAppId}`,
              WINEPREFIX: winePrefix,
              PROTONPATH: 'UMU-Latest',
              PWD: libraryInfo.cwd,
            },
            cwd: redistDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }

        const timeout = setTimeout(
          () => {
            if (child.pid) {
              child.kill('SIGTERM');
            }
            finalize(false);
          },
          10 * 60 * 1000
        ); // 10 minute timeout

        child.on(
          'close',
          (code: number | null, signal: NodeJS.Signals | null) => {
            clearTimeout(timeout);
            const success = code === 0 && signal == null && !!child.pid;
            if (!success && signal != null) {
              console.error(`[umu-legacy] Process killed by signal: ${signal}`);
            }
            finalize(success);
          }
        );

        child.on('error', (error) => {
          clearTimeout(timeout);
          console.error('[umu-legacy] Redistributable error:', error);
          finalize(false);
        });
      });

      if (success) {
        sendNotification({
          message: `Installed ${redistributable.name} for ${libraryInfo.name}`,
          id: generateNotificationId(),
          type: 'success',
        });
      } else {
        anyFailed = true;
        sendNotification({
          message: `Failed to install ${redistributable.name} for ${libraryInfo.name}`,
          id: generateNotificationId(),
          type: 'error',
        });
      }
    } catch (error) {
      anyFailed = true;
      console.error(
        `[umu-legacy] Error installing ${redistributable.name}:`,
        error
      );
      sendNotification({
        message: `Failed to install ${redistributable.name} for ${libraryInfo.name}`,
        id: generateNotificationId(),
        type: 'error',
      });
    }
  }

  // Clear redistributables from the library file
  if (!anyFailed) {
    const updatedInfo = loadLibraryInfo(appID);
    if (updatedInfo) {
      delete updatedInfo.redistributables;
      saveLibraryInfo(appID, updatedInfo);
    }
  }

  sendNotification({
    message: anyFailed
      ? `Finished installing dependencies for ${libraryInfo.name} (some failed)`
      : `Finished installing dependencies for ${libraryInfo.name}`,
    id: generateNotificationId(),
    type: anyFailed ? 'warning' : 'success',
  });

  return anyFailed ? 'failed' : 'success';
}

/**
 * Get silent install flags for redistributable files
 */
function getSilentInstallFlags(fileName: string): string[] {
  const lowerFileName = fileName.toLowerCase();

  if (
    lowerFileName.includes('vcredist') ||
    lowerFileName.includes('vc_redist')
  ) {
    return ['/S', '/v/qn'];
  }

  if (
    lowerFileName.includes('directx') ||
    lowerFileName.includes('dxwebsetup')
  ) {
    return ['/S'];
  }

  if (lowerFileName.includes('dotnet') || lowerFileName.includes('netfx')) {
    if (lowerFileName.includes('netfxrepairtool')) {
      return ['/p'];
    }
    return ['/S', '/v/qn'];
  }

  if (lowerFileName.endsWith('.msi')) {
    return ['/S', '/qn'];
  }

  if (lowerFileName.includes('nsis') || lowerFileName.includes('setup')) {
    return ['/S'];
  }

  if (lowerFileName.includes('inno')) {
    return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
  }

  if (lowerFileName.includes('installshield')) {
    return ['/S', '/v/qn'];
  }

  return ['/S'];
}

/**
 * Migrate an existing game from legacy mode to UMU
 * This copies the existing Steam prefix to the new UMU location
 */
export async function migrateToUmu(
  appID: number,
  oldSteamAppId: number
): Promise<{ success: boolean; error?: string }> {
  console.log(
    `[umu] Migrating game ${appID} from legacy Steam prefix to UMU...`
  );

  const libraryInfo = loadLibraryInfo(appID);
  if (!libraryInfo) {
    return { success: false, error: 'Game not found' };
  }

  if (!libraryInfo.umu) {
    return { success: false, error: 'No UMU configuration found' };
  }

  const homeDir = getHomeDir();
  if (!homeDir) {
    return { success: false, error: 'Home directory not found' };
  }

  const oldPrefixPath = path.join(
    homeDir,
    '.steam',
    'steam',
    'steamapps',
    'compatdata',
    oldSteamAppId.toString()
  );

  const { umuId } = libraryInfo.umu;
  const newPrefixPath = getUmuWinePrefix(umuId);

  if (!fs.existsSync(oldPrefixPath)) {
    console.log('[umu] Old prefix not found, skipping migration');
    // Still mark as migrated, just start fresh
    libraryInfo.legacyMode = false;
    saveLibraryInfo(appID, libraryInfo);
    return { success: true };
  }

  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(newPrefixPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Copy the prefix
    console.log(
      `[umu] Copying prefix from ${oldPrefixPath} to ${newPrefixPath}`
    );
    await copyDirectory(oldPrefixPath, newPrefixPath);

    // Update library info
    libraryInfo.legacyMode = false;
    libraryInfo.umu = {
      ...libraryInfo.umu,
      winePrefixPath: newPrefixPath,
    };
    saveLibraryInfo(appID, libraryInfo);

    console.log('[umu] Migration completed successfully');
    return { success: true };
  } catch (error) {
    console.error('[umu] Migration failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Copy directory recursively
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(srcPath);
      fs.symlinkSync(linkTarget, destPath);
    } else if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Register UMU IPC handlers
 */
export function registerUmuHandlers() {
  // Check if UMU is installed
  ipcMain.handle('app:check-umu-installed', async () => {
    return await isUmuInstalled();
  });

  // Install UMU
  ipcMain.handle('app:install-umu', async () => {
    return await installUmu();
  });

  // Launch game with UMU
  ipcMain.handle('app:launch-with-umu', async (_, appID: number) => {
    const libraryInfo = loadLibraryInfo(appID);
    if (!libraryInfo) {
      return { success: false, error: 'Game not found' };
    }

    // Check if migration is needed
    if (libraryInfo.legacyMode) {
      console.log('[umu] Game is in legacy mode, cannot launch with UMU');
      return {
        success: false,
        error: 'Game is in legacy mode. Please migrate to UMU first.',
      };
    }

    return await launchWithUmu(libraryInfo);
  });

  // Install redistributables with UMU
  ipcMain.handle(
    'app:install-redistributables-umu',
    async (_, appID: number) => {
      return await installRedistributablesWithUmu(appID);
    }
  );

  // Migrate game to UMU
  ipcMain.handle(
    'app:migrate-to-umu',
    async (_, appID: number, oldSteamAppId: number) => {
      return await migrateToUmu(appID, oldSteamAppId);
    }
  );
}
