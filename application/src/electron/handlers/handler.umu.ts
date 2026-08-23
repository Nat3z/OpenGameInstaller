import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { ipcProcedure, procedure, router } from '@/electron/rpc/router-core.js';

/**
 * UMU (Unified Launcher for Windows Games on Linux) IPC handlers
 * Replaces the legacy Steam/flatpak wine system with UMU Launcher
 */

import type { LibraryInfo } from '@ogi-sdk/connect';
import { formatError, PlatformError } from '@ogi-sdk/errors';
import { type ChildProcess, type SpawnOptions, spawn } from 'child_process';
import { Effect } from 'effect';
import * as fs from 'fs';
import * as path from 'path';
import { getSilentInstallFlags } from '@/electron/handlers/helpers.app/install-flags.js';
import {
  loadLibraryInfo,
  saveLibraryInfo,
} from '@/electron/handlers/helpers.app/library.js';
import { generateNotificationId } from '@/electron/handlers/helpers.app/notifications.js';
import {
  getCompatDataDir,
  getHomeDir,
  isLinux,
} from '@/electron/handlers/helpers.app/platform.js';
import {
  getUmuLaunchEnvironment,
  getUmuRedistributableEnvironment,
} from '@/electron/handlers/helpers.app/umu-environment.js';
import {
  type LaunchArgumentToken,
  parseLaunchArgumentTokens,
  resolveLaunchCommandTokens,
} from '@/electron/lib/launch-command.js';
import { resolveSpawnInvocation } from '@/electron/lib/spawn-shell.js';
import {
  resolveLegacyPrefixSource,
  stagedPrefixMigration as runStagedPrefixMigration,
} from '@/electron/lib/umu-prefix-migration.js';
import { sendNotification } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import {
  runElectronEffect,
  runEffectBoundary as runUmuBoundary,
} from '@/electron/runtime.js';
import { downloadLatestUmu } from '@/electron/startup.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/**
 * Get the UMU prefix base directory
 * Throws an error if home directory cannot be determined
 */
function getUmuPrefixBase(): string {
  const home = getHomeDir();
  if (!home) {
    throw new PlatformError({
      message: 'Cannot determine home directory for UMU prefix base',
      platform: process.platform,
    });
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
const UMU_PROTON_PLACEHOLDER = 'umu-proton';

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export { parseLaunchArgumentTokens } from '@/electron/lib/launch-command.js';

function isKnownLaunchEnvAssignment(token: string): boolean {
  const separatorIndex = token.indexOf('=');
  if (separatorIndex <= 0) return false;
  const key = token.slice(0, separatorIndex);
  return KNOWN_LAUNCH_ENV_VARS.has(key);
}

function stripLeadingLaunchEnvTokens(
  tokens: LaunchArgumentToken[]
): LaunchArgumentToken[] {
  let start = 0;
  while (
    start < tokens.length &&
    ENV_ASSIGNMENT_PATTERN.test(tokens[start].value)
  ) {
    start++;
  }
  return tokens.slice(start);
}

function normalizeProtonPathValue(value?: string | null): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.toLowerCase() === UMU_PROTON_PLACEHOLDER) {
    return undefined;
  }
  return normalized;
}

function parseLeadingLaunchEnvFromArguments(
  launchArguments?: string
): Record<string, string> {
  const env: Record<string, string> = {};
  const tokens = parseLaunchArgumentTokens(launchArguments);
  for (const token of tokens) {
    if (!ENV_ASSIGNMENT_PATTERN.test(token.value)) break;
    const separatorIndex = token.value.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = token.value.slice(0, separatorIndex).trim();
    const value = token.value.slice(separatorIndex + 1).trim();
    if (!key) continue;
    env[key] = value;
  }
  return env;
}

export function parseLaunchArguments(launchArguments?: string): string[] {
  return stripLeadingLaunchEnvTokens(parseLaunchArgumentTokens(launchArguments))
    .map((token) => token.value)
    .filter(
      (token) => token !== '%command%' && !isKnownLaunchEnvAssignment(token)
    );
}

export function parseLaunchArgumentsAfterCommand(
  launchArguments?: string
): string[] {
  const tokens = stripLeadingLaunchEnvTokens(
    parseLaunchArgumentTokens(launchArguments)
  ).filter((token) => !isKnownLaunchEnvAssignment(token.value));
  const commandIndex = tokens.findIndex((token) => token.value === '%command%');
  if (commandIndex === -1) {
    return [];
  }
  return tokens
    .slice(commandIndex + 1)
    .map((token) => token.value)
    .filter((token) => token !== '%command%');
}

export function resolveLaunchCommand(
  launchExecutable: string,
  launchArguments?: string,
  executableArgs: readonly string[] = []
): ReturnType<typeof resolveLaunchCommandTokens> {
  const tokens = stripLeadingLaunchEnvTokens(
    parseLaunchArgumentTokens(launchArguments)
  ).filter((token) => !isKnownLaunchEnvAssignment(token.value));
  return resolveLaunchCommandTokens(launchExecutable, executableArgs, tokens);
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

/**
 * Parse WINEDLLOVERRIDES value into an array of override entries.
 * Preserves full override spec when present (e.g. "dinput8=n,b" stays "dinput8=n,b").
 * Entries without "=" (bare DLL names) are left as-is; buildDllOverrides will infer "=n,b".
 */
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

  const entries: string[] = [];
  for (const segment of normalizedValue.split(';')) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) continue;
    const eqIndex = trimmedSegment.indexOf('=');
    if (eqIndex >= 0) {
      const leftSide = trimmedSegment.slice(0, eqIndex).trim();
      const value = trimmedSegment.slice(eqIndex + 1).trim();
      if (!leftSide) continue;
      for (const dllName of leftSide.split(',')) {
        const normalizedDllName = dllName
          .trim()
          .replace(/^\\?['"]/, '')
          .replace(/\\?['"]$/, '');
        if (!normalizedDllName) continue;
        entries.push(`${normalizedDllName}=${value}`);
      }
    } else {
      const normalizedDllName = trimmedSegment
        .replace(/^\\?['"]/, '')
        .replace(/\\?['"]$/, '');
      if (!normalizedDllName) continue;
      entries.push(normalizedDllName);
    }
  }
  return uniqueCaseInsensitive(entries);
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
    token.value.startsWith('WINEDLLOVERRIDES=')
  );
  if (!dllOverrideAssignment) {
    return [];
  }

  const rawValue = dllOverrideAssignment.value.slice(
    'WINEDLLOVERRIDES='.length
  );
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
    if (normalizedKey === 'PROTONPATH') {
      const protonPath = normalizeProtonPathValue(String(value));
      if (!protonPath) continue;
      sanitized[normalizedKey] = protonPath;
      continue;
    }
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
  result?: 'success' | 'partial' | 'failed' | 'not-found';
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
      logger.sync.info(`${prefix} ${line}`);
    }
  });

  child.stderr?.on('data', (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      logger.sync.error(`${prefix} ${line}`);
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
    throw new PlatformError({
      message: 'No UMU configuration found',
      platform: process.platform,
    });
  }

  const winePrefix = getLibraryUmuWinePrefix(libraryInfo);
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
    logger.sync.info(
      `[umu] Updated UMU from ${result.currentVersion ?? 'none'} to ${result.latestVersion ?? 'latest'}`
    );
  } else {
    logger.sync.info(
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

export function getLibraryUmuWinePrefix(
  libraryInfo: Pick<LibraryInfo, 'umu'>
): string {
  if (!libraryInfo.umu) {
    throw new PlatformError({
      message: 'No UMU configuration found',
      platform: process.platform,
    });
  }
  return (
    libraryInfo.umu.winePrefixPath ?? getUmuWinePrefix(libraryInfo.umu.umuId)
  );
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
 * Build WINEDLLOVERRIDES string from dllOverrides array.
 * Wine expects DLL names without the .dll extension (e.g., "dinput8=n,b").
 * Only appends "=n,b" when an entry has no override spec (bare DLL name); otherwise preserves the existing spec.
 */
export function buildDllOverrides(dllOverrides: string[]): string {
  if (!dllOverrides || dllOverrides.length === 0) {
    return '';
  }

  const overrides = dllOverrides.map((entry) => {
    const eqIndex = entry.indexOf('=');
    const dllPart =
      eqIndex >= 0 ? entry.slice(0, eqIndex).trim() : entry.trim();
    const dllName = path.basename(dllPart).replace(/\.dll$/i, '');
    if (!dllName) return '';
    if (eqIndex >= 0) {
      const value = entry.slice(eqIndex + 1).trim();
      return value ? `${dllName}=${value}` : `${dllName}=n,b`;
    }
    return `${dllName}=n,b`;
  });

  return overrides.filter(Boolean).join(';');
}

/**
 * Launch a game using UMU
 * @param libraryInfo - Game library entry
 * @param options.onExit - Optional callback when the game process exits (for UI lifecycle events)
 */
export async function launchWithUmu(
  libraryInfo: LibraryInfo,
  options?: {
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  }
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
    logger.sync.info('[umu] UMU not found, attempting auto-install...');
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
  const protonPath = normalizeProtonPathValue(protonVersion);
  const gameId = convertUmuId(umuId);
  const winePrefix = getLibraryUmuWinePrefix(libraryInfo);
  const launchEnv = getEffectiveLaunchEnv(libraryInfo);
  const dllOverrides = getEffectiveDllOverrides(libraryInfo);
  const dllOverrideStr = buildDllOverrides(dllOverrides);

  // Build environment variables
  const env = getUmuLaunchEnvironment({
    launchEnvironment: launchEnv,
    gameId,
    winePrefix,
    cwd: libraryInfo.cwd,
    protonPath,
  });

  if (store) {
    env.STORE = store;
  }

  // Build DLL overrides
  if (dllOverrideStr) {
    env.WINEDLLOVERRIDES = dllOverrideStr;
  }

  const exePath = libraryInfo.launchExecutable;
  const { command, args, tokens } = resolveLaunchCommand(
    umuRunExecutable,
    libraryInfo.launchArguments,
    [exePath]
  );
  const spawnInvocation = resolveSpawnInvocation(command, args, tokens);

  // Log launch info without leaking full env (may contain secrets)
  const envSummary = {
    keyCount: Object.keys(env).length,
    hasWINEPREFIX: 'WINEPREFIX' in env,
    hasPROTONPATH: 'PROTONPATH' in env,
  };
  logger.sync.info('[umu] Launching game:', {
    name: libraryInfo.name,
    gameId,
    winePrefix,
    protonVersion: protonPath,
    store: store || 'none',
    hasDllOverrides: dllOverrides.length > 0,
    environment: envSummary,
  });

  return new Promise((resolve) => {
    logger.sync.info("[umu] command i'm running: ", command, args);
    const spawnOptions: SpawnOptions = {
      cwd: libraryInfo.cwd,
      shell: spawnInvocation.shell,
      env: {
        ...env,
        PWD: libraryInfo.cwd,
        UMU_LOG: 'debug',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    const child: ChildProcess = spawnInvocation.args
      ? spawn(spawnInvocation.command, spawnInvocation.args, spawnOptions)
      : spawn(spawnInvocation.command, spawnOptions);
    child.unref();

    child.stdout?.on('data', (data) => {
      logger.sync.info(`[umu stdout] ${data}`);
    });

    child.stderr?.on('data', (data) => {
      logger.sync.error(`[umu stderr] ${data}`);
    });

    const onExitCallback = options?.onExit;

    child.on('error', (error) => {
      logger.sync.error('[umu] Failed to launch game:', error);
      resolve({ success: false, error: error.message });
    });

    child.on('exit', (code, signal) => {
      onExitCallback?.(code, signal ?? null);
      if (code === 0) {
        logger.sync.info(
          `[umu] Game process exited normally with code ${code}`
        );
      } else {
        logger.sync.error(
          `[umu] Game process exited abnormally, code: ${code}, signal: ${signal}`
        );
      }
    });

    // Resolve immediately after successful spawn so caller can return; onExit runs when process exits
    resolve({ success: true, pid: child.pid });
  });
}

/**
 * Install redistributables using UMU winetricks
 */
export async function installRedistributablesWithUmu(
  appID: number,
  reportProgress?: RedistributableProgressReporter
): Promise<'success' | 'partial' | 'failed' | 'not-found'> {
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
  if (!libraryInfo.umu) {
    logger.sync.info(
      '[umu] No UMU configuration found, skipping UMU redistributables'
    );
    reportProgress?.({
      kind: 'done',
      total: libraryInfo.redistributables?.length ?? 0,
      completedCount: 0,
      failedCount: libraryInfo.redistributables?.length ?? 0,
      overallProgress: 100,
      result: 'failed',
      error: 'No UMU configuration found, cannot use UMU redistributable flow',
    });
    return 'failed';
  }

  if (!libraryInfo.redistributables) {
    logger.sync.info('[umu] No redistributables to install');
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
  const protonPath = normalizeProtonPathValue(protonVersion);
  const gameId = umuId ? convertUmuId(umuId) : 'umu-default';
  const winePrefix = getLibraryUmuWinePrefix(libraryInfo);

  const redistributables = libraryInfo.redistributables || [];
  const totalRedistributables = redistributables.length;

  logger.sync.info(
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

        const env = getUmuRedistributableEnvironment({
          gameId,
          winePrefix,
          cwd: libraryInfo.cwd,
          protonPath,
        });

        let child: ReturnType<typeof spawn>;

        if (redistributable.path === 'winetricks') {
          // Use winetricks verb
          child = spawn(
            umuRunExecutable,
            ['winetricks', '-q', '-f', redistributable.name],
            {
              env,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
        } else if (
          redistributable.path === 'microsoft' &&
          redistributable.name === 'dotnet-repair'
        ) {
          // Special case for .NET repair tool
          // This would need to be downloaded and run
          logger.sync.info(
            '[umu] .NET repair tool not yet implemented for UMU'
          );
          finalize(false);
          return;
        } else {
          // Regular redistributable file (resolve relative to game cwd)
          const redistPath = path.resolve(
            libraryInfo.cwd,
            redistributable.path
          );
          if (!fs.existsSync(redistPath)) {
            logger.sync.error('[umu] Redistributable not found:', redistPath);
            finalize(false);
            return;
          }

          const redistDir = path.dirname(redistPath);
          const redistFile = path.basename(redistPath);

          // Determine silent install flags
          const silentFlags = getSilentInstallFlags(redistFile);

          child = spawn(umuRunExecutable, [redistFile, ...silentFlags], {
            env,
            cwd: redistDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }

        streamChildProcessOutput(child, `[umu redist:${redistributable.name}]`);

        child.on(
          'close',
          (code: number | null, signal: NodeJS.Signals | null) => {
            const success = code === 0 && signal == null && !!child.pid;
            if (!success && signal != null) {
              logger.sync.error(
                `[umu] Redistributable process killed by signal: ${signal}`
              );
            }
            finalize(success);
          }
        );

        child.on('error', (error) => {
          logger.sync.error('[umu] Redistributable error:', error);
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
      logger.sync.error(
        `[umu] Error installing ${redistributable.name}:`,
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
    result: !anyFailed ? 'success' : completedCount > 0 ? 'partial' : 'failed',
  });

  // Partial failure is distinct from total failure so the UI can warn without
  // treating the whole setup as broken.
  if (!anyFailed) return 'success';
  return completedCount > 0 ? 'partial' : 'failed';
}
async function initializePrefixWithUmuRun(
  libraryInfo: LibraryInfo,
  umuId: string,
  winePrefix: string,
  logPrefix: string,
  signal?: AbortSignal
): Promise<{ success: boolean; error?: string }> {
  const umuInstalled = await isUmuInstalled();
  if (!umuInstalled) {
    logger.sync.info(
      '[umu] UMU not found during prefix init, attempting auto-install'
    );
    const installResult = await installUmu();
    if (!installResult.success) {
      return {
        success: false,
        error: installResult.error ?? 'Failed to install UMU',
      };
    }
  }

  if (signal?.aborted) {
    return { success: false, error: 'UMU prefix initialization was cancelled' };
  }

  ensureUmuPrefixBase();
  if (!fs.existsSync(winePrefix)) {
    fs.mkdirSync(winePrefix, { recursive: true });
  }

  const gameId = convertUmuId(umuId);
  const cwd = libraryInfo.cwd || process.cwd();
  const protonPath = normalizeProtonPathValue(libraryInfo.umu?.protonVersion);

  const initialized = await new Promise<boolean>((resolve) => {
    let resolved = false;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    const initChildEnv: NodeJS.ProcessEnv = {
      ...process.env,
      UMU_LOG: 'debug',
      GAMEID: gameId,
      WINEPREFIX: winePrefix,
      PWD: cwd,
    };
    if (protonPath) {
      initChildEnv.PROTONPATH = protonPath;
    }

    const initChild = spawn(umuRunExecutable, [''], {
      cwd,
      env: initChildEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    streamChildProcessOutput(initChild, logPrefix);

    let timedOut = false;
    const handleAbort = () => {
      if (!initChild.pid) return;
      initChild.kill('SIGTERM');
      forceKillTimeout = setTimeout(() => {
        if (initChild.exitCode === null && initChild.signalCode === null) {
          initChild.kill('SIGKILL');
        }
      }, 5_000);
    };
    const timeout = setTimeout(
      () => {
        timedOut = true;
        handleAbort();
      },
      5 * 60 * 1000
    );
    const finalize = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      signal?.removeEventListener('abort', handleAbort);
      resolve(result);
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted) handleAbort();

    initChild.on(
      'close',
      (code: number | null, childSignal: NodeJS.Signals | null) => {
        finalize(
          code === 0 && childSignal == null && !signal?.aborted && !timedOut
        );
      }
    );

    initChild.on('error', (error) => {
      logger.sync.error('[umu] Prefix init error:', error);
      finalize(false);
    });
  });

  return initialized
    ? { success: true }
    : { success: false, error: 'UMU could not initialize the Wine prefix' };
}

export const stagedPrefixMigration = (params: {
  appID: number;
  libraryInfo: LibraryInfo;
  sourcePath?: string;
  finalPath: string;
  umuId: string;
  commit?: (libraryInfo: LibraryInfo) => void;
}): Effect.Effect<LibraryInfo, PlatformError> =>
  runStagedPrefixMigration({
    libraryInfo: params.libraryInfo,
    sourcePath: params.sourcePath,
    finalPath: params.finalPath,
    initialize: params.sourcePath
      ? undefined
      : async (stagingPath, signal) => {
          logger.sync.info('[umu] Initializing a fresh staged UMU prefix');
          const initialized = await initializePrefixWithUmuRun(
            params.libraryInfo,
            params.umuId,
            stagingPath,
            '[umu migration prefix-init]',
            signal
          );
          if (!initialized.success) {
            throw new Error(
              initialized.error ?? 'UMU could not initialize the Wine prefix'
            );
          }
        },
    commit: params.commit ?? ((info) => saveLibraryInfo(params.appID, info)),
  });

/** Migrate a legacy prefix through a validated sibling staging directory. */
export async function migrateToUmu(
  appID: number,
  oldSteamAppId?: number,
  updates?: Partial<LibraryInfo>
): Promise<{ success: boolean; error?: string; libraryInfo?: LibraryInfo }> {
  if (!isLinux()) return { success: false, error: 'Only available on Linux' };
  const libraryInfo = loadLibraryInfo(appID);
  if (!libraryInfo) return { success: false, error: 'Game not found' };

  const legacyLaunchEnv = parseLeadingLaunchEnvFromArguments(
    libraryInfo.launchArguments
  );
  const configuredLegacyPrefix =
    libraryInfo.launchEnv?.WINEPREFIX ?? legacyLaunchEnv.WINEPREFIX;
  const configuredCompatDataPath =
    libraryInfo.launchEnv?.STEAM_COMPAT_DATA_PATH ??
    legacyLaunchEnv.STEAM_COMPAT_DATA_PATH;
  const legacyShortcutExecutable = libraryInfo.launchExecutable;
  const legacyShortcutName = libraryInfo.version?.trim()
    ? `${libraryInfo.name} (${libraryInfo.version})`
    : libraryInfo.name;
  Object.assign(libraryInfo, updates);
  if (libraryInfo.launchEnv) {
    const migratedLaunchEnv = { ...libraryInfo.launchEnv };
    delete migratedLaunchEnv.WINEPREFIX;
    delete migratedLaunchEnv.STEAM_COMPAT_DATA_PATH;
    libraryInfo.launchEnv =
      Object.keys(migratedLaunchEnv).length > 0 ? migratedLaunchEnv : undefined;
  }

  if (!libraryInfo.umu) {
    const fallbackUmuId = oldSteamAppId
      ? (`steam:${oldSteamAppId}` as const)
      : (`umu:${appID}` as const);
    libraryInfo.umu = { umuId: fallbackUmuId };
  }
  if (oldSteamAppId !== undefined) {
    libraryInfo.umu.steamShortcutReaddId = oldSteamAppId;
    libraryInfo.umu.steamShortcutLegacyExecutable = legacyShortcutExecutable;
    libraryInfo.umu.steamShortcutLegacyName = legacyShortcutName;
  }
  const effectiveDllOverrides = getEffectiveDllOverrides(libraryInfo);
  if (effectiveDllOverrides.length > 0) {
    libraryInfo.umu = {
      ...libraryInfo.umu,
      dllOverrides: effectiveDllOverrides,
    };
  }
  if (libraryInfo.launchArguments) {
    libraryInfo.launchArguments = libraryInfo.launchArguments
      .replace(
        /(?:^|\s)WINEPREFIX=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]*)/gi,
        ' '
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  const { umuId } = libraryInfo.umu;
  const finalPath = getLibraryUmuWinePrefix(libraryInfo);
  const sourcePath = resolveLegacyPrefixSource({
    steamCompatDataPath: oldSteamAppId
      ? path.join(getCompatDataDir(oldSteamAppId), oldSteamAppId.toString())
      : undefined,
    configuredCompatDataPath,
    configuredPrefix: configuredLegacyPrefix,
  });

  const result = await runElectronEffect(
    Effect.either(
      stagedPrefixMigration({
        appID,
        libraryInfo,
        sourcePath,
        finalPath,
        umuId,
      })
    )
  );
  if (result._tag === 'Left') {
    logger.sync.error('[umu] Migration failed:', result.left);
    return { success: false, error: result.left.message };
  }
  logger.sync.info('[umu] Migration completed successfully');
  return { success: true, libraryInfo: result.right };
}

const withUmuBoundary = <A>(
  operation: () => Promise<A>
): Effect.Effect<A, PlatformError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new PlatformError({
        message: formatError(cause),
        platform: process.platform,
      }),
  });

/** Define UMU procedures. */
export function registerUmuHandlers() {
  return router(
    procedure(ElectronRpc.app.checkUmuInstalled, () =>
      runUmuBoundary(withUmuBoundary(isUmuInstalled))
    ),
    procedure(ElectronRpc.app.installUmu, () =>
      runUmuBoundary(withUmuBoundary(installUmu))
    ),
    procedure(ElectronRpc.app.launchWithUmu, (appID: number) =>
      runUmuBoundary(
        Effect.gen(function* () {
          const libraryInfo = loadLibraryInfo(appID);
          if (!libraryInfo?.umu) {
            return yield* Effect.fail(
              new PlatformError({
                message: 'Game is not configured for UMU',
                platform: process.platform,
              })
            );
          }
          return yield* withUmuBoundary(() => launchWithUmu(libraryInfo));
        })
      )
    ),
    ipcProcedure(
      ElectronRpc.app.installRedistributablesUmu,
      (_, appID: number) =>
        runUmuBoundary(
          withUmuBoundary(() => installRedistributablesWithUmu(appID))
        )
    ),
    ipcProcedure(
      ElectronRpc.app.migrateToUmu,
      (_, appID: number, oldSteamAppId?: number) =>
        runUmuBoundary(
          withUmuBoundary(() => migrateToUmu(appID, oldSteamAppId))
        )
    )
  );
}
