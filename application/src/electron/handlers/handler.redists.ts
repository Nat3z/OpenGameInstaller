/**
 * Redistributable installation handlers
 * Uses UMU (Unified Launcher for Windows Games on Linux) for all games
 */
import { ipcMain } from 'electron';
import type { LibraryInfo } from 'ogi-addon';
import { isLinux } from './helpers.app/platform.js';
import { getNonSteamGameAppID } from './helpers.app/steam.js';
import { loadLibraryInfo } from './helpers.app/library.js';
import {
  installRedistributablesWithUmu,
  installRedistributablesWithUmuForLegacy,
} from './handler.umu.js';

export function registerRedistributableHandlers() {
  ipcMain.handle(
    'app:install-redistributables',
    async (_, appID: number): Promise<'success' | 'failed' | 'not-found'> => {
      if (!isLinux()) {
        return 'failed';
      }

      const appInfo = loadLibraryInfo(appID) as
        | (LibraryInfo & {
            redistributables?: { name: string; path: string }[];
          })
        | null;

      if (!appInfo) {
        return 'not-found';
      }

      // Determine mode: UMU or legacy
      if (appInfo.umu) {
        console.log('[redistributables] Installing via UMU');
        return await installRedistributablesWithUmu(appID);
      } else {
        // Legacy mode: always use UMU for prefix and redistributables
        // Steam App ID is inferred dynamically via steamtinkerlaunch nonsteamgame system
        console.log(
          '[redistributables] Installing via UMU for legacy game (using Steam App ID from steamtinkerlaunch)'
        );

        // Look up Steam App ID dynamically using steamtinkerlaunch nonsteamgame system
        const versionedGameName = `${appInfo.name} (${appInfo.version})`;
        const { success, appId: steamAppId } =
          await getNonSteamGameAppID(versionedGameName);

        if (!success || !steamAppId) {
          console.error(
            '[redistributables] Failed to get Steam App ID from steamtinkerlaunch'
          );
          return 'failed';
        }

        console.log('[redistributables] Inferred Steam App ID:', steamAppId);
        return await installRedistributablesWithUmuForLegacy(appID, steamAppId);
      }
    }
  );
}
