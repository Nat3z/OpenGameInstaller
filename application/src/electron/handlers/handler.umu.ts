/**
 * UMU (Unified Launcher for Windows Games on Linux) IPC handlers
 * Replaces the legacy Steam/flatpak wine system with UMU Launcher
 */
import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { LibraryInfo } from 'ogi-addon';
import { isLinux, getHomeDir } from './helpers.app/platform.js';
import { loadLibraryInfo, saveLibraryInfo } from './helpers.app/library.js';
import { generateNotificationId } from './helpers.app/notifications.js';
import { sendNotification } from '../main.js';
import { __dirname } from '../manager/manager.paths.js';
import { downloadLatestUmu } from '../startup.js';

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
const KNOWN_LAUNCH_ENV_VARS = new Set([
  'WINEPREFIX',
  'WINEDLLOVERRIDES',
  'STEAM_COMPAT_DATA_PATH',
  'PROTONPATH',
  'GAMEID',
  'STORE',
]);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function parseLaunchArgumentTokens(launchArguments?: string): string[] {
  const launchArgs = (launchArguments || '').replace('%command%', '');
  return (
    launchArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((arg) => {
      const trimmed = arg.trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ) {
        return trimmed.slice(1, -1);
      }
      return trimmed;
    }) ?? []
  );
}

function isKnownLaunchEnvAssignment(token: string): boolean {
  const separatorIndex = token.indexOf('=');
  if (separatorIndex <= 0) return false;
  const key = token.slice(0, separatorIndex);
  return KNOWN_LAUNCH_ENV_VARS.has(key);
}

function parseLeadingLaunchEnvFromArguments(
  launchArguments?: string
): Record<string, string> {
  const env: Record<string, string> = {};
  const tokens = parseLaunchArgumentTokens(launchArguments);
  for (const token of tokens) {
    if (!ENV_ASSIGNMENT_PATTERN.test(token)) break;
    const separatorIndex = token.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = token.slice(0, separatorIndex).trim();
    const value = token.slice(separatorIndex + 1).trim();
    if (!key) continue;
    env[key] = value;
  }
  return env;
}

function parseLaunchArguments(launchArguments?: string): string[] {
  const tokens = parseLaunchArgumentTokens(launchArguments);
  let start = 0;
  while (start < tokens.length && ENV_ASSIGNMENT_PATTERN.test(tokens[start])) {
    start++;
  }
  return tokens
    .slice(start)
    .filter((token) => !isKnownLaunchEnvAssignment(token));
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

function parseDllOverridesValue(rawValue: string): string[] {
  const trimmedValue = rawValue.trim();
  if (!trimmedValue) return [];

  const unquotedValue =
    (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
    (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"))
      ? trimmedValue.slice(1, -1)
      : trimmedValue;
  const normalizedValue =
    (unquotedValue.startsWith('\\"') && unquotedValue.endsWith('\\"')) ||
    (unquotedValue.startsWith("\\'") && unquotedValue.endsWith("\\'"))
      ? unquotedValue.slice(2, -2)
      : unquotedValue;

  const dllNames: string[] = [];
  for (const segment of normalizedValue.split(';')) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) continue;
    const [leftSide] = trimmedSegment.split('=');
    if (!leftSide) continue;
    for (const dllName of leftSide.split(',')) {
      const normalizedDllName = dllName
        .trim()
        .replace(/^\\?['"]/, '')
        .replace(/\\?['"]$/, '');
      if (!normalizedDllName) continue;
      dllNames.push(normalizedDllName);
    }
  }
  return uniqueCaseInsensitive(dllNames);
}

/**
 * Extract DLL overrides from launch arguments such as:
 * WINEDLLOVERRIDES=dinput8=n,b;dxgi=n,b %command%
 */
export function inferDllOverridesFromLaunchArguments(
  launchArguments?: string
): string[] {
  const tokens = parseLaunchArgumentTokens(launchArguments);
  const dllOverrideAssignment = tokens.find((token) =>
    token.startsWith('WINEDLLOVERRIDES=')
  );
  if (!dllOverrideAssignment) {
    return [];
  }

  const rawValue = dllOverrideAssignment.slice('WINEDLLOVERRIDES='.length);
  return parseDllOverridesValue(rawValue);
}

function inferDllOverridesFromLaunchEnv(launchEnv?: Record<string, string>) {
  const rawValue = launchEnv?.WINEDLLOVERRIDES;
  if (!rawValue) return [];
  return parseDllOverridesValue(rawValue);
}

export function getEffectiveLaunchEnv(
  libraryInfo: Pick<LibraryInfo, 'launchArguments' | 'launchEnv'>
): Record<string, string> {
  const fromLaunchArguments = parseLeadingLaunchEnvFromArguments(
    libraryInfo.launchArguments
  );
  const fromLibraryInfo = libraryInfo.launchEnv || {};
  const merged = { ...fromLaunchArguments, ...fromLibraryInfo };
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    if (value === undefined || value === null) continue;
    sanitized[normalizedKey] = String(value);
  }
  return sanitized;
}

export function getEffectiveDllOverrides(
  libraryInfo: Pick<LibraryInfo, 'launchArguments' | 'launchEnv' | 'umu'>
): string[] {
  const effectiveLaunchEnv = getEffectiveLaunchEnv(libraryInfo);
  return uniqueCaseInsensitive([
    ...(libraryInfo.umu?.dllOverrides || []),
    ...inferDllOverridesFromLaunchArguments(libraryInfo.launchArguments),
    ...inferDllOverridesFromLaunchEnv(effectiveLaunchEnv),
  ]);
}

export type RedistributableInstallProgress = {
  kind: 'item' | 'done';
  total: number;
  completedCount: number;
  failedCount: number;
  overallProgress: number;
  redistributableName?: string;
  redistributablePath?: string;
  index?: number;
  status?: 'installing' | 'completed' | 'failed';
  result?: 'success' | 'failed' | 'not-found';
  error?: string;
};

type RedistributableProgressReporter = (
  progress: RedistributableInstallProgress
) => void;

function streamChildProcessOutput(
  child: ReturnType<typeof spawn>,
  prefix: string
): void {
  child.stdout?.on('data', (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      console.log(`${prefix} ${line}`);
    }
  });

  child.stderr?.on('data', (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      console.error(`${prefix} ${line}`);
    }
  });
}

export function getUmuRunExecutablePath(): string {
  return umuRunExecutable;
}

/**
 * Builds a wrapper template for Steam shortcut launches.
 * `%command%` is intentionally left in place so Steam resolves it to the
 * shortcut executable command at launch time.
 */
export function buildUmuWrapperCommandTemplate(
  libraryInfo: LibraryInfo
): string {
  if (!libraryInfo.umu) {
    throw new Error('No UMU configuration found');
  }

  const { umuId } = libraryInfo.umu;
  const winePrefix = getUmuWinePrefix(umuId);
  const dllOverrides = getEffectiveDllOverrides(libraryInfo);
  const dllOverrideString = buildDllOverrides(dllOverrides);
  const parsedLaunchArgs = parseLaunchArguments(libraryInfo.launchArguments);

  const parts = [`PROTON_COMPAT_DATA_PATH=${shellQuote(winePrefix)}`];
  if (dllOverrideString) {
    parts.push(`WINEDLLOVERRIDES=${shellQuote(dllOverrideString)}`);
  }
  parts.push('%command%', ...parsedLaunchArgs.map((arg) => shellQuote(arg)));

  return parts.join(' ');
}
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

/**
 * Auto-install UMU launcher.
 * Uses startup updater flow, which compares local and latest GitHub versions
 * before downloading/extracting.
 */
export async function installUmu(): Promise<{
  success: boolean;
  error?: string;
}> {
  const result = await downloadLatestUmu();
  if (!result.success) {
    return { success: false, error: result.error ?? 'Unknown UMU error' };
  }
  if (result.updated) {
    console.log(
      `[umu] Updated UMU from ${result.currentVersion ?? 'none'} to ${result.latestVersion ?? 'latest'}`
    );
  } else {
    console.log(
      `[umu] UMU already up to date (${result.latestVersion ?? result.currentVersion ?? 'unknown'})`
    );
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

  const { umuId, protonVersion, store } = libraryInfo.umu;
  const gameId = convertUmuId(umuId);
  const winePrefix = getUmuWinePrefix(umuId);
  const launchEnv = getEffectiveLaunchEnv(libraryInfo);
  const dllOverrides = getEffectiveDllOverrides(libraryInfo);
  const dllOverrideStr = buildDllOverrides(dllOverrides);

  // Build environment variables
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...launchEnv,
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
  if (dllOverrideStr) {
    env.WINEDLLOVERRIDES = dllOverrideStr;
  }

  const exePath = libraryInfo.launchExecutable;
  const parsedLaunchArgs = parseLaunchArguments(libraryInfo.launchArguments);

  console.log('[umu] Launching game:', {
    name: libraryInfo.name,
    gameId,
    winePrefix,
    protonVersion: protonVersion,
    store: store || 'none',
    hasDllOverrides: dllOverrides.length > 0,
    environment: env,
  });

  return new Promise((resolve) => {
    console.log("[umu] command i'm running: ", umuRunExecutable, [
      exePath,
      ...parsedLaunchArgs,
    ]);
    const child = spawn(umuRunExecutable, [exePath, ...parsedLaunchArgs], {
      cwd: libraryInfo.cwd,
      env: {
        ...env,
        GAMEID: gameId,
        WINEPREFIX: winePrefix,
        PROTONPATH: protonVersion || 'UMU-Latest',
        ...(store ? { STORE: store } : {}),
        ...(dllOverrideStr ? { WINEDLLOVERRIDES: dllOverrideStr } : {}),
        PWD: libraryInfo.cwd,
        UMU_LOG: 'debug',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
  appID: number,
  reportProgress?: RedistributableProgressReporter
): Promise<'success' | 'failed' | 'not-found'> {
  if (!isLinux()) {
    reportProgress?.({
      kind: 'done',
      total: 0,
      completedCount: 0,
      failedCount: 0,
      overallProgress: 100,
      result: 'failed',
      error: 'UMU redistributables are only available on Linux',
    });
    return 'failed';
  }

  const libraryInfo = loadLibraryInfo(appID);
  if (!libraryInfo) {
    reportProgress?.({
      kind: 'done',
      total: 0,
      completedCount: 0,
      failedCount: 0,
      overallProgress: 100,
      result: 'not-found',
      error: `Game not found for appID ${appID}`,
    });
    return 'not-found';
  }

  // Check if this is a legacy game
  if (libraryInfo.legacyMode) {
    console.log('[umu] Legacy mode game, skipping UMU redistributables');
    reportProgress?.({
      kind: 'done',
      total: libraryInfo.redistributables?.length ?? 0,
      completedCount: 0,
      failedCount: libraryInfo.redistributables?.length ?? 0,
      overallProgress: 100,
      result: 'failed',
      error: 'Game is in legacy mode and cannot use UMU redistributable flow',
    });
    return 'failed';
  }

  if (!libraryInfo.umu && !libraryInfo.redistributables) {
    console.log('[umu] No redistributables to install');
    reportProgress?.({
      kind: 'done',
      total: 0,
      completedCount: 0,
      failedCount: 0,
      overallProgress: 100,
      result: 'success',
    });
    return 'success';
  }

  // Ensure UMU is installed
  const umuInstalled = await isUmuInstalled();
  if (!umuInstalled) {
    const installResult = await installUmu();
    if (!installResult.success) {
      reportProgress?.({
        kind: 'done',
        total: libraryInfo.redistributables?.length ?? 0,
        completedCount: 0,
        failedCount: libraryInfo.redistributables?.length ?? 0,
        overallProgress: 100,
        result: 'failed',
        error: installResult.error ?? 'Failed to install UMU',
      });
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
  const totalRedistributables = redistributables.length;

  console.log(
    `[umu] Installing ${redistributables.length} redistributables for ${libraryInfo.name}`
  );

  let anyFailed = false;
  let completedCount = 0;
  let failedCount = 0;
  for (const [index, redistributable] of redistributables.entries()) {
    reportProgress?.({
      kind: 'item',
      total: totalRedistributables,
      completedCount,
      failedCount,
      overallProgress:
        totalRedistributables === 0
          ? 100
          : ((completedCount + failedCount) / totalRedistributables) * 100,
      redistributableName: redistributable.name,
      redistributablePath: redistributable.path,
      index,
      status: 'installing',
    });

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

        let child: ReturnType<typeof spawn>;

        if (redistributable.path === 'winetricks') {
          // Use winetricks verb
          child = spawn(
            umuRunExecutable,
            ['winetricks', '-q', redistributable.name],
            {
              env: {
                ...env,
                PROTONPATH: protonVersion || 'UMU-Latest',
                PWD: libraryInfo.cwd,
              },
              stdio: 'inherit',
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
              PROTONPATH: protonVersion || 'UMU-Latest',
              PWD: libraryInfo.cwd,
            },
            cwd: redistDir,
            stdio: 'inherit',
          });
        }

        streamChildProcessOutput(child, `[umu redist:${redistributable.name}]`);

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
        completedCount++;
        sendNotification({
          message: `Installed ${redistributable.name} for ${libraryInfo.name}`,
          id: generateNotificationId(),
          type: 'success',
        });
        reportProgress?.({
          kind: 'item',
          total: totalRedistributables,
          completedCount,
          failedCount,
          overallProgress:
            totalRedistributables === 0
              ? 100
              : ((completedCount + failedCount) / totalRedistributables) * 100,
          redistributableName: redistributable.name,
          redistributablePath: redistributable.path,
          index,
          status: 'completed',
        });
      } else {
        anyFailed = true;
        failedCount++;
        sendNotification({
          message: `Failed to install ${redistributable.name} for ${libraryInfo.name}`,
          id: generateNotificationId(),
          type: 'error',
        });
        reportProgress?.({
          kind: 'item',
          total: totalRedistributables,
          completedCount,
          failedCount,
          overallProgress:
            totalRedistributables === 0
              ? 100
              : ((completedCount + failedCount) / totalRedistributables) * 100,
          redistributableName: redistributable.name,
          redistributablePath: redistributable.path,
          index,
          status: 'failed',
        });
      }
    } catch (error) {
      anyFailed = true;
      failedCount++;
      console.error(`[umu] Error installing ${redistributable.name}:`, error);
      sendNotification({
        message: `Failed to install ${redistributable.name} for ${libraryInfo.name}`,
        id: generateNotificationId(),
        type: 'error',
      });
      reportProgress?.({
        kind: 'item',
        total: totalRedistributables,
        completedCount,
        failedCount,
        overallProgress:
          totalRedistributables === 0
            ? 100
            : ((completedCount + failedCount) / totalRedistributables) * 100,
        redistributableName: redistributable.name,
        redistributablePath: redistributable.path,
        index,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
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

  const unresolvedCount = Math.max(
    0,
    totalRedistributables - completedCount - failedCount
  );
  reportProgress?.({
    kind: 'done',
    total: totalRedistributables,
    completedCount,
    failedCount: anyFailed ? failedCount + unresolvedCount : failedCount,
    overallProgress: 100,
    result: anyFailed ? 'failed' : 'success',
  });

  return anyFailed ? 'failed' : 'success';
}

/**
 * Install redistributables for legacy games using UMU with Steam prefix
 * This creates the prefix at the Steam compatdata location using UMU
 */
export async function installRedistributablesWithUmuForLegacy(
  appID: number,
  steamAppId: number,
  reportProgress?: RedistributableProgressReporter
): Promise<'success' | 'failed' | 'not-found'> {
  if (!isLinux()) {
    reportProgress?.({
      kind: 'done',
      total: 0,
      completedCount: 0,
      failedCount: 0,
      overallProgress: 100,
      result: 'failed',
      error: 'UMU redistributables are only available on Linux',
    });
    return 'failed';
  }

  const libraryInfo = loadLibraryInfo(appID);
  if (!libraryInfo) {
    reportProgress?.({
      kind: 'done',
      total: 0,
      completedCount: 0,
      failedCount: 0,
      overallProgress: 100,
      result: 'not-found',
      error: `Game not found for appID ${appID}`,
    });
    return 'not-found';
  }

  if (
    !libraryInfo.redistributables ||
    libraryInfo.redistributables.length === 0
  ) {
    console.log('[umu-legacy] No redistributables to install');
    reportProgress?.({
      kind: 'done',
      total: 0,
      completedCount: 0,
      failedCount: 0,
      overallProgress: 100,
      result: 'success',
    });
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
      reportProgress?.({
        kind: 'done',
        total: libraryInfo.redistributables.length,
        completedCount: 0,
        failedCount: libraryInfo.redistributables.length,
        overallProgress: 100,
        result: 'failed',
        error: installResult.error ?? 'Failed to install UMU',
      });
      return 'failed';
    }
  }

  // Get the Steam compatdata prefix path
  const homeDir = getHomeDir();
  if (!homeDir) {
    console.error('[umu-legacy] Cannot determine home directory');
    reportProgress?.({
      kind: 'done',
      total: libraryInfo.redistributables.length,
      completedCount: 0,
      failedCount: libraryInfo.redistributables.length,
      overallProgress: 100,
      result: 'failed',
      error: 'Cannot determine home directory',
    });
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
          ...process.env,
          UMU_LOG: 'debug',
          GAMEID: `umu-${steamAppId}`,
          WINEPREFIX: winePrefix,
          PROTONPATH: 'UMU-Latest',
          PWD: libraryInfo.cwd,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    streamChildProcessOutput(initChild, '[umu-legacy prefix-init]');

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
    reportProgress?.({
      kind: 'done',
      total: libraryInfo.redistributables.length,
      completedCount: 0,
      failedCount: libraryInfo.redistributables.length,
      overallProgress: 100,
      result: 'failed',
      error: 'Failed to initialize Wine prefix with UMU',
    });
    return 'failed';
  }

  console.log('[umu-legacy] Prefix initialized successfully');

  // Now install redistributables using UMU winetricks
  const redistributables = libraryInfo.redistributables;
  const totalRedistributables = redistributables.length;
  let anyFailed = false;
  let completedCount = 0;
  let failedCount = 0;

  for (const [index, redistributable] of redistributables.entries()) {
    reportProgress?.({
      kind: 'item',
      total: totalRedistributables,
      completedCount,
      failedCount,
      overallProgress:
        totalRedistributables === 0
          ? 100
          : ((completedCount + failedCount) / totalRedistributables) * 100,
      redistributableName: redistributable.name,
      redistributablePath: redistributable.path,
      index,
      status: 'installing',
    });

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

        let child: ReturnType<typeof spawn>;

        if (redistributable.path === 'winetricks') {
          // Use winetricks verb via UMU
          child = spawn(
            umuRunExecutable,
            ['winetricks', '-q', redistributable.name],
            {
              env: {
                ...process.env,
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
              ...process.env,
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

        streamChildProcessOutput(
          child,
          `[umu-legacy redist:${redistributable.name}]`
        );

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
        completedCount++;
        sendNotification({
          message: `Installed ${redistributable.name} for ${libraryInfo.name}`,
          id: generateNotificationId(),
          type: 'success',
        });
        reportProgress?.({
          kind: 'item',
          total: totalRedistributables,
          completedCount,
          failedCount,
          overallProgress:
            totalRedistributables === 0
              ? 100
              : ((completedCount + failedCount) / totalRedistributables) * 100,
          redistributableName: redistributable.name,
          redistributablePath: redistributable.path,
          index,
          status: 'completed',
        });
      } else {
        anyFailed = true;
        failedCount++;
        sendNotification({
          message: `Failed to install ${redistributable.name} for ${libraryInfo.name}`,
          id: generateNotificationId(),
          type: 'error',
        });
        reportProgress?.({
          kind: 'item',
          total: totalRedistributables,
          completedCount,
          failedCount,
          overallProgress:
            totalRedistributables === 0
              ? 100
              : ((completedCount + failedCount) / totalRedistributables) * 100,
          redistributableName: redistributable.name,
          redistributablePath: redistributable.path,
          index,
          status: 'failed',
        });
      }
    } catch (error) {
      anyFailed = true;
      failedCount++;
      console.error(
        `[umu-legacy] Error installing ${redistributable.name}:`,
        error
      );
      sendNotification({
        message: `Failed to install ${redistributable.name} for ${libraryInfo.name}`,
        id: generateNotificationId(),
        type: 'error',
      });
      reportProgress?.({
        kind: 'item',
        total: totalRedistributables,
        completedCount,
        failedCount,
        overallProgress:
          totalRedistributables === 0
            ? 100
            : ((completedCount + failedCount) / totalRedistributables) * 100,
        redistributableName: redistributable.name,
        redistributablePath: redistributable.path,
        index,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
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

  const unresolvedCount = Math.max(
    0,
    totalRedistributables - completedCount - failedCount
  );
  reportProgress?.({
    kind: 'done',
    total: totalRedistributables,
    completedCount,
    failedCount: anyFailed ? failedCount + unresolvedCount : failedCount,
    overallProgress: 100,
    result: anyFailed ? 'failed' : 'success',
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
  oldSteamAppId?: number
): Promise<{ success: boolean; error?: string }> {
  console.log(
    `[umu] Migrating game ${appID} from legacy Steam prefix to UMU...`
  );

  if (!isLinux()) {
    return { success: false, error: 'Only available on Linux' };
  }

  const libraryInfo = loadLibraryInfo(appID);
  if (!libraryInfo) {
    return { success: false, error: 'Game not found' };
  }

  if (!libraryInfo.umu) {
    const fallbackUmuId = oldSteamAppId
      ? (`steam:${appID}` as const)
      : (`umu:${appID}` as const);
    libraryInfo.umu = {
      umuId: fallbackUmuId,
      winePrefixPath: getUmuWinePrefix(fallbackUmuId),
    };
    console.log(
      `[umu] No UMU configuration found for ${appID}, created fallback config with umuId=${fallbackUmuId}`
    );
  }
  const effectiveDllOverrides = getEffectiveDllOverrides(libraryInfo);
  if (effectiveDllOverrides.length > 0) {
    libraryInfo.umu = {
      ...libraryInfo.umu,
      dllOverrides: effectiveDllOverrides,
    };
  }

  const homeDir = getHomeDir();
  if (!homeDir) {
    return { success: false, error: 'Home directory not found' };
  }

  const { umuId } = libraryInfo.umu;
  const newPrefixPath = getUmuWinePrefix(umuId);
  let oldPrefixPath: string | undefined;

  if (oldSteamAppId) {
    oldPrefixPath = path.join(
      homeDir,
      '.steam',
      'steam',
      'steamapps',
      'compatdata',
      oldSteamAppId.toString()
    );
  }

  if (!oldPrefixPath) {
    console.log('[umu] Old Steam app ID not provided, skipping prefix copy');
    libraryInfo.legacyMode = false;
    libraryInfo.umu = {
      ...libraryInfo.umu,
      winePrefixPath: newPrefixPath,
    };
    saveLibraryInfo(appID, libraryInfo);
    return { success: true };
  }

  if (!fs.existsSync(oldPrefixPath)) {
    console.log('[umu] Old prefix not found, skipping migration');
    // Still mark as migrated, just start fresh
    libraryInfo.legacyMode = false;
    libraryInfo.umu = {
      ...libraryInfo.umu,
      winePrefixPath: newPrefixPath,
    };
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
    async (_, appID: number, oldSteamAppId?: number) => {
      return await migrateToUmu(appID, oldSteamAppId);
    }
  );
}
