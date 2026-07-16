/**
 * Steam/Proton helper functions
 */

import { exec, execFile } from 'child_process';
import { Effect } from 'effect';
import {
  notifyError,
  notifySuccess,
} from '@/electron/handlers/helpers.app/notifications.js';
import { getOgiExecutablePath } from '@/electron/handlers/helpers.app/platform.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { STEAMTINKERLAUNCH_PATH } from '@/electron/startup.js';

/**
 * Escapes a string for safe use in shell commands by escaping special characters
 */
function escapeShellArg(arg: string): string {
  // Replace any backslashes first (to avoid double-escaping)
  // Then escape double quotes, dollar signs, backticks, and backslashes
  return arg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

/**
 * Escapes a value so it can be safely embedded inside a double-quoted argument.
 * Escapes backslashes, double quotes, $ and backticks to prevent shell expansion.
 */
function escapeDoubleQuotedValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

const cachedAppIds: Record<string, number> = {};

/**
 * Helper function to format game name with version
 * Returns plain name if version is falsy/blank to support legacy app IDs
 */
export function getVersionedGameName(
  name: string,
  version?: string | null
): string {
  // Guard for falsy/blank version (undefined, null, empty string, whitespace)
  if (!version || !version.trim()) {
    return name;
  }
  return `${name} (${version})`;
}

/**
 * Get the Steam App ID for a non-Steam game using steamtinkerlaunch
 * Output format from STL: "<appid>\t(<game name>)" or "<appid> (<game name>)"
 */
export function getNonSteamGameAppID(gameName: string): Effect.Effect<{
  success: boolean;
  appId?: number;
  error?: string;
}> {
  return Effect.gen(function* () {
    if (cachedAppIds[gameName]) {
      return { success: true, appId: cachedAppIds[gameName] };
    }

    return yield* Effect.async<{
      success: boolean;
      appId?: number;
      error?: string;
    }>((resume) => {
      execFile(
        STEAMTINKERLAUNCH_PATH,
        ['getid', gameName],
        { cwd: __dirname },
        (error, stdout, _stderr) => {
          if (error) {
            console.error('[getNonSteamGameAppID] Error:', error);
            resume(Effect.succeed({ success: false, error: error.message }));
            return;
          }

          const output = stdout.trim();
          const appIdLine = output
            .split('\n')
            .find((line) => line.includes('(' + gameName + ')'));
          if (!appIdLine) {
            console.error(
              '[getNonSteamGameAppID] Could not find app ID for game:',
              gameName
            );
            resume(
              Effect.succeed({
                success: false,
                error: 'Could not find app ID for game',
              })
            );
            return;
          }

          const appId = parseInt(appIdLine.split('(')[0].trim());
          console.log(
            `[getNonSteamGameAppID] Found app ID ${appId} for "${gameName}"`
          );
          cachedAppIds[gameName] = appId;
          resume(Effect.succeed({ success: true, appId }));
        }
      );
    });
  });
}

/**
 * Consolidated Steam app ID lookup with fallback
 * Tries versioned name first, then falls back to plain name if that fails
 */
export function getSteamAppIdWithFallback(
  name: string,
  version?: string | null,
  context?: string
): Effect.Effect<{ success: boolean; appId?: number; error?: string }> {
  return Effect.gen(function* () {
    const versionedGameName = getVersionedGameName(name, version);
    let { success, appId } = yield* getNonSteamGameAppID(versionedGameName);

    if (!success) {
      const fallbackResult = yield* getNonSteamGameAppID(name);
      if (fallbackResult.success) {
        success = true;
        appId = fallbackResult.appId;
        const contextPrefix = context ? `[${context}] ` : '';
        console.log(
          `${contextPrefix}Found Steam app ID using plain name "${name}" after versioned lookup failed.`
        );
      }
    }

    return {
      success,
      appId,
      error: success ? undefined : 'Failed to get Steam app ID',
    };
  });
}

/**
 * Add game to Steam via SteamTinkerLaunch using OGI wrapper mode.
 * Steam launches OGI, then OGI executes the wrapper command.
 */
export function addGameToSteam(params: {
  name: string;
  version?: string;
  launchExecutable: string;
  cwd: string;
  wrapperCommand?: string;
  appID: number;
  compatibilityTool?: string;
}): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const ogiPath = getOgiExecutablePath();
    const wrapperCommand =
      params.wrapperCommand && params.wrapperCommand.length > 0
        ? params.wrapperCommand
        : '%command%';
    const launchOptions = `"${ogiPath}" --game-id=${params.appID} --no-sandbox -- "${escapeDoubleQuotedValue(wrapperCommand)}"`;
    const compatibilityToolArg = params.compatibilityTool
      ? ` --compatibilitytool="${escapeShellArg(params.compatibilityTool)}"`
      : '';

    return yield* Effect.async<boolean>((resume) => {
      exec(
        `${STEAMTINKERLAUNCH_PATH} addnonsteamgame --appname="${escapeShellArg(params.name)}" --exepath="${escapeShellArg(params.launchExecutable)}" --startdir="${escapeShellArg(params.cwd)}" --launchoptions="${escapeShellArg(launchOptions)}"${compatibilityToolArg} --use-steamgriddb`,
        { cwd: __dirname },
        (error, stdout, stderr) => {
          if (error) {
            console.error(error);
            notifyError('Failed to add game to Steam');
            resume(Effect.succeed(false));
            return;
          }
          console.log(stdout);
          console.log(stderr);
          notifySuccess('Game added to Steam');
          resume(Effect.succeed(true));
        }
      );
    });
  });
}
