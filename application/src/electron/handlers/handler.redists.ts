/**
 * Redistributable installation handlers
 * Uses UMU (Unified Launcher for Windows Games on Linux) for all games
 */
import { ipcMain } from 'electron';
import type { LibraryInfo } from 'ogi-addon';
import { isLinux } from './helpers.app/platform.js';
import {
  getNonSteamGameAppID,
  getVersionedGameName,
} from './helpers.app/steam.js';
import { loadLibraryInfo } from './helpers.app/library.js';
import {
  installRedistributablesWithUmu,
  installRedistributablesWithUmuForLegacy,
  type RedistributableInstallProgress,
} from './handler.umu.js';
import { sendIPCMessage } from '../main.js';

export function registerRedistributableHandlers() {
  ipcMain.handle(
    'app:install-redistributables',
    async (
      _,
      appID: number,
      downloadId?: string
    ): Promise<'success' | 'failed' | 'not-found'> => {
      const emitProgress = (progress: RedistributableInstallProgress) => {
        void sendIPCMessage('app:redistributable-progress', {
          appID,
          downloadId,
          ...progress,
        });
      };

      if (!isLinux()) {
        emitProgress({
          kind: 'done',
          total: 0,
          completedCount: 0,
          failedCount: 0,
          overallProgress: 100,
          result: 'failed',
          error: 'Redistributable installation is only supported on Linux',
        });
        return 'failed';
      }

      const appInfo = loadLibraryInfo(appID) as
        | (LibraryInfo & {
            redistributables?: { name: string; path: string }[];
          })
        | null;

      if (!appInfo) {
        emitProgress({
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

      // Determine mode: UMU or legacy
      if (appInfo.umu) {
        console.log('[redistributables] Installing via UMU');
        return await installRedistributablesWithUmu(appID, emitProgress);
      } else {
        // Legacy mode: always use UMU for prefix and redistributables
        // Steam App ID is inferred dynamically via steamtinkerlaunch nonsteamgame system
        console.log(
          '[redistributables] Installing via UMU for legacy game (using Steam App ID from steamtinkerlaunch)'
        );

        // Look up Steam App ID dynamically using steamtinkerlaunch nonsteamgame system
        const versionedGameName = getVersionedGameName(appInfo.name, appInfo.version);
        const { success, appId: steamAppId } =
          await getNonSteamGameAppID(versionedGameName);

        if (!success || !steamAppId) {
          console.error(
            '[redistributables] Failed to get Steam App ID from steamtinkerlaunch'
          );
          emitProgress({
            kind: 'done',
            total: appInfo.redistributables?.length ?? 0,
            completedCount: 0,
            failedCount: appInfo.redistributables?.length ?? 0,
            overallProgress: 100,
            result: 'failed',
            error:
              'Failed to resolve Steam App ID from steamtinkerlaunch for legacy redistributable install',
          });
          return 'failed';
        }

        console.log('[redistributables] Inferred Steam App ID:', steamAppId);
        return await installRedistributablesWithUmuForLegacy(
          appID,
          steamAppId,
          emitProgress
        );
      }
    }
  );
}
