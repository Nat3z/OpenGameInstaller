import {
  BrowserWindow,
  app,
  dialog,
  screen,
  ipcMain,
  shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkIfInstallerUpdateAvailable,
  UpdaterCallbacks,
} from './updater/self-updater';
import {
  createSplashWindow,
  updateSplashStatus,
  updateSplashProgress,
  closeSplashWindow,
} from './splash';
import {
  backupUserData,
  restoreBackup,
  removeCachedAppUpdates,
  reinstallAddonDependencies,
} from './backup-restore';
import { executeMigrations } from './migrations';
import { loadPlayStatistics } from './play-statistics';

let splashWindow: BrowserWindow | null = null;
let splashTargetWindow: BrowserWindow | null = null;

export async function runStartupTasks(
  mainWindow?: BrowserWindow | null
): Promise<void> {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      splashTargetWindow = mainWindow;
    } else {
      // Legacy: separate splash window (e.g. if run without main window)
      splashWindow = createSplashWindow();
    }

    // Reconcile play statistics once at startup (close any stale session from previous run)
    updateSplashStatus('Reconciling play statistics...');
    loadPlayStatistics(true);

    // Restore backup if it exists
    updateSplashStatus('Restoring backup...');
    const backupResult = await restoreBackup((file, current, total) => {
      updateSplashStatus('Restoring backup', `${file} (${current}/${total})`);
      updateSplashProgress(current, total, '');
    });

    // Run any migrations if necessary
    updateSplashStatus('Running migrations...');
    // not async because it relies on the app being open
    executeMigrations();

    // Remove cached app updates
    updateSplashStatus('Cleaning up...');
    await new Promise((resolve, _) =>
      removeCachedAppUpdates()
        .then(resolve)
        .catch(() => {
          console.error('[chore] Failed to remove cached app updates');
          resolve(void 0);
        })
    );

    // If addons need reinstallation (node_modules were skipped during backup)
    if (backupResult.needsAddonReinstall) {
      updateSplashStatus('Reinstalling addon dependencies...');
      try {
        await reinstallAddonDependencies((addonName, current, total) => {
          updateSplashStatus(
            'Installing addon dependencies',
            `${addonName} (${current}/${total})`
          );
          updateSplashProgress(current, total, '');
        });
      } catch (error) {
        console.error(
          '[startup] Failed to reinstall addon dependencies:',
          error
        );
        // Continue anyway - addons may still work or can be reinstalled later
      }
    }

    // Check for installer/setup updates with splash screen callbacks
    updateSplashStatus('Checking for updates...');
    const updaterCallbacks: UpdaterCallbacks = {
      onStatus: (text: string, subtext?: string) => {
        updateSplashStatus(text, subtext);
      },
      onProgress: (current: number, total: number, speed: string) => {
        updateSplashProgress(current, total, speed);
      },
    };
    await checkIfInstallerUpdateAvailable(updaterCallbacks);

    // Final status before main window loads
    updateSplashStatus('Starting application...');
  } finally {
    splashTargetWindow = null;
    // Ensure splash window is closed if it was created
    closeSplashWindow();
  }
}
