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
import {
  loadLibraryInfo,
  saveLibraryInfo,
} from './helpers.app/library.js';
import { generateNotificationId } from './helpers.app/notifications.js';
import { sendNotification } from '../main.js';

const execAsync = promisify(exec);

// UMU constants
const UMU_INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/Open-Wine-Components/umu-launcher/8ed817f83a49eefade7c8af9e59b01d24f4317c/install.sh';

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

/**
 * Check if UMU is installed on the system
 */
export async function isUmuInstalled(): Promise<boolean> {
  try {
    await execAsync('which umu-run');
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-install UMU launcher
 * Downloads install script to temp file, verifies basic sanity, then executes
 */
export async function installUmu(): Promise<{ success: boolean; error?: string }> {
  console.log('[umu] Installing UMU launcher...');

  const tmpDir = '/tmp';
  const installScriptPath = path.join(tmpDir, 'umu-install.sh');

  try {
    // Download the install script
    console.log('[umu] Downloading install script...');
    await execAsync(
      `curl -L -o ${installScriptPath} ${UMU_INSTALL_SCRIPT_URL}`,
      { timeout: 60000 }
    );

    // Basic sanity check: script should exist and not be empty
    const stats = fs.statSync(installScriptPath);
    if (stats.size < 100) {
      throw new Error('Downloaded script appears to be empty or corrupted');
    }

    // Verify it's a shell script (basic check)
    const firstLine = fs.readFileSync(installScriptPath, 'utf8').split('\n')[0];
    if (!firstLine.includes('bash') && !firstLine.includes('sh')) {
      throw new Error('Downloaded file does not appear to be a shell script');
    }

    // Make executable and run
    fs.chmodSync(installScriptPath, '755');
    console.log('[umu] Running install script...');
    await execAsync(`bash ${installScriptPath}`, { timeout: 120000 });

    // Clean up
    try {
      fs.unlinkSync(installScriptPath);
    } catch {
      // Ignore cleanup errors
    }

    // Verify installation
    const installed = await isUmuInstalled();
    if (!installed) {
      throw new Error('UMU installation verification failed');
    }

    console.log('[umu] UMU installed successfully');
    return { success: true };
  } catch (error) {
    console.error('[umu] Failed to install UMU:', error);
    // Clean up on failure
    try {
      if (fs.existsSync(installScriptPath)) {
        fs.unlinkSync(installScriptPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
export function buildDllOverrides(
  dllOverrides: string[]
): string {
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

  // Build launch arguments
  const launchArgs = libraryInfo.launchArguments || '';
  const exePath = path.join(libraryInfo.cwd, libraryInfo.launchExecutable);
  const parsedLaunchArgs =
    launchArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((arg) =>
      arg.replace(/^['"]|['"]$/g, '')
    ) ?? [];

  console.log('[umu] Launching game:', {
    name: libraryInfo.name,
    gameId,
    winePrefix,
    protonVersion: protonVersion || 'UMU-Proton (latest)',
    store: store || 'none',
    hasDllOverrides: !!dllOverrides && dllOverrides.length > 0,
  });

  return new Promise((resolve) => {
    const child = spawn('umu-run', [exePath, ...parsedLaunchArgs], {
      cwd: libraryInfo.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const finish = (result: { success: boolean; error?: string; pid?: number }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on('data', (data) => {
      console.log(`[umu stdout] ${data}`);
    });

    child.stderr?.on('data', (data) => {
      console.error(`[umu stderr] ${data}`);
    });

    child.on('error', (error) => {
      console.error('[umu] Failed to launch game:', error);
      finish({ success: false, error: error.message });
    });

    // UMU/Proton first-run can take longer; use a longer readiness window
    const readinessTimeout = setTimeout(() => {
      if (child.pid && !child.killed) {
        console.log(`[umu] Game launch command started with PID ${child.pid}`);
        finish({ success: true, pid: child.pid });
      } else {
        finish({ success: false, error: 'Failed to get game process ID' });
      }
    }, 5000);

    child.on('spawn', () => {
      // Spawned successfully; resolve immediately with PID
      if (child.pid) {
        clearTimeout(readinessTimeout);
        finish({ success: true, pid: child.pid });
      }
    });

    child.unref();
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
  const winePrefix = umuId ? getUmuWinePrefix(umuId) : path.join(getUmuPrefixBase(), 'umu-default');

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
        };

        if (protonVersion) {
          env.PROTONPATH = protonVersion;
        }

        let child;

        if (redistributable.path === 'winetricks') {
          // Use winetricks verb
          child = spawn('umu-run', ['winetricks', redistributable.name, '--force', '--unattended', '-q'], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } else if (redistributable.path === 'microsoft' && redistributable.name === 'dotnet-repair') {
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

          child = spawn('umu-run', [redistFile, ...silentFlags], {
            env,
            cwd: redistDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }

        const timeout = setTimeout(() => {
          if (child.pid) {
            child.kill('SIGTERM');
          }
          finalize(false);
        }, 10 * 60 * 1000); // 10 minute timeout

        child.on('close', (code) => {
          clearTimeout(timeout);
          finalize(code === 0);
        });

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

  // Clear redistributables from the library file after installation
  const updatedInfo = loadLibraryInfo(appID);
  if (updatedInfo) {
    delete updatedInfo.redistributables;
    saveLibraryInfo(appID, updatedInfo);
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
 * Get silent install flags for redistributable files
 */
function getSilentInstallFlags(fileName: string): string[] {
  const lowerFileName = fileName.toLowerCase();

  if (lowerFileName.includes('vcredist') || lowerFileName.includes('vc_redist')) {
    return ['/S', '/v/qn'];
  }

  if (lowerFileName.includes('directx') || lowerFileName.includes('dxwebsetup')) {
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
  console.log(`[umu] Migrating game ${appID} from legacy Steam prefix to UMU...`);

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
    console.log(`[umu] Copying prefix from ${oldPrefixPath} to ${newPrefixPath}`);
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
  ipcMain.handle('app:install-redistributables-umu', async (_, appID: number) => {
    return await installRedistributablesWithUmu(appID);
  });

  // Migrate game to UMU
  ipcMain.handle('app:migrate-to-umu', async (_, appID: number, oldSteamAppId: number) => {
    return await migrateToUmu(appID, oldSteamAppId);
  });
}
