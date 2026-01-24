/**
 * Steam/Proton helper functions
 */
import { exec } from 'child_process';
import { __dirname } from '../../manager/manager.paths.js';
import { STEAMTINKERLAUNCH_PATH } from '../../startup.js';
import { notifyError, notifySuccess } from './notifications.js';

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
export function getNonSteamGameAppID(
  gameName: string
): Promise<{ success: boolean; appId?: number; error?: string }> {
  return new Promise((resolve) => {
    if (cachedAppIds[gameName]) {
      resolve({ success: true, appId: cachedAppIds[gameName] });
      return;
    }
    exec(
      `${STEAMTINKERLAUNCH_PATH} getid "${escapeShellArg(gameName)}"`,
      { cwd: __dirname },
      (error, stdout, _stderr) => {
        if (error) {
          console.error('[getNonSteamGameAppID] Error:', error);
          resolve({ success: false, error: error.message });
          return;
        }

        // Parse the output - extract just the numbers (appid)
        // Output format: "Preparing to installSteamTinkerLaunch...\njefopwejfoew\nfijwepfjoeww\n....\n<appid><tab or space>(<game name>)"
        const output = stdout.trim();
        const appIdLine = output
          .split('\n')
          .find((line) => line.includes('(' + gameName + ')'));
        if (!appIdLine) {
          console.error(
            '[getNonSteamGameAppID] Could not find app ID for game:',
            gameName
          );
          resolve({
            success: false,
            error: 'Could not find app ID for game',
          });
          return;
        }
        const appId = parseInt(appIdLine.split('(')[0].trim());
        console.log(
          `[getNonSteamGameAppID] Found app ID ${appId} for "${gameName}"`
        );
        resolve({ success: true, appId });
        cachedAppIds[gameName] = appId;
      }
    );
  });
}

/**
 * Consolidated Steam app ID lookup with fallback
 * Tries versioned name first, then falls back to plain name if that fails
 */
export async function getSteamAppIdWithFallback(
  name: string,
  version?: string | null,
  context?: string
): Promise<{ success: boolean; appId?: number; error?: string }> {
  const versionedGameName = getVersionedGameName(name, version);
  let { success, appId } = await getNonSteamGameAppID(versionedGameName);

  // If lookup with versioned name failed, try with plain name (for legacy shortcuts)
  if (!success) {
    const fallbackResult = await getNonSteamGameAppID(name);
    if (fallbackResult.success) {
      success = true;
      appId = fallbackResult.appId;
      const contextPrefix = context ? `[${context}] ` : '';
      console.log(
        `${contextPrefix}Found Steam app ID using plain name "${name}" after versioned lookup failed.`
      );
    }
  }

  return { success, appId, error: success ? undefined : 'Failed to get Steam app ID' };
}

/**
 * Add game to Steam via SteamTinkerLaunch
 */
export async function addGameToSteam(params: {
  name: string;
  version?: string;
  launchExecutable: string;
  cwd: string;
  launchOptions: string;
}): Promise<boolean> {
  const versionedGameName = getVersionedGameName(params.name, params.version);

  return new Promise<boolean>((resolve) =>
    exec(
      `${STEAMTINKERLAUNCH_PATH} addnonsteamgame --appname="${escapeShellArg(versionedGameName)}" --exepath="${escapeShellArg(params.launchExecutable)}" --startdir="${escapeShellArg(params.cwd)}" --launchoptions="${escapeShellArg(params.launchOptions)}" --compatibilitytool="proton_experimental" --use-steamgriddb`,
      {
        cwd: __dirname,
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error(error);
          notifyError('Failed to add game to Steam');
          resolve(false);
          return;
        }
        console.log(stdout);
        console.log(stderr);
        notifySuccess('Game added to Steam');
        resolve(true);
      }
    )
  );
}
