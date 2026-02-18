/**
 * Redistributable installation handlers
 * Uses UMU (Unified Launcher for Windows Games on Linux) exclusively
 */
import { ipcMain } from 'electron';
import type { LibraryInfo } from 'ogi-addon';
import { isLinux } from './helpers.app/platform.js';
import { loadLibraryInfo } from './helpers.app/library.js';
import { installRedistributablesWithUmu } from './handler.umu.js';

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

      // All games use UMU mode for redistributables
      console.log('[redistributables] Installing via UMU');
      return await installRedistributablesWithUmu(appID);
    }
  );
}
