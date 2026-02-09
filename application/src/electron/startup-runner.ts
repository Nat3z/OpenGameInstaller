import { BrowserWindow } from 'electron';
import {
  checkIfInstallerUpdateAvailable,
  type UpdaterCallbacks,
} from './updater.js';
import {
  restoreBackup,
  removeCachedAppUpdates,
  reinstallAddonDependencies,
} from './startup.js';
import { execute } from './migrations.js';
import { loadPlayStatistics } from './handlers/helpers.app/play-statistics.js';
import {
  createSplashWindow,
  setSplashTargetWindow,
  setSplashWindow,
  updateSplashStatus,
  updateSplashProgress,
  closeSplashWindow,
} from './splash.js';

export async function runStartupTasks(
  mainWindow?: BrowserWindow | null
): Promise<void> {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      setSplashTargetWindow(mainWindow);
    } else {
      // Legacy: separate splash window (e.g. if run without main window)
      setSplashWindow(createSplashWindow());
    }

    // Reconcile play statistics once at startup (close any stale session from previous run)
    updateSplashStatus('Reconciling play statistics...');
    loadPlayStatistics(true);

    // Restore backup if it exists
    updateSplashStatus('Restoring backup...');
    const backupResult = await restoreBackup(
      (file: string, current: number, total: number): void => {
        updateSplashStatus('Restoring backup', `${file} (${current}/${total})`);
        updateSplashProgress(current, total, '');
      }
    );

    // Run any migrations if necessary
    updateSplashStatus('Running migrations...');
    try {
      await execute();
    } catch (err) {
      console.error('[startup] Migrations failed:', err);
      // Continue anyway so the app can start
    }

    // Remove cached app updates
    updateSplashStatus('Cleaning up...');
    await removeCachedAppUpdates().catch(() => {
      console.error('[chore] Failed to remove cached app updates');
    });

    // If addons need reinstallation (node_modules were skipped during backup)
    if (backupResult.needsAddonReinstall) {
      updateSplashStatus('Reinstalling addon dependencies...');
      try {
        await reinstallAddonDependencies(
          (addonName: string, current: number, total: number): void => {
            updateSplashStatus(
              'Installing addon dependencies',
              `${addonName} (${current}/${total})`
            );
            updateSplashProgress(current, total, '');
          }
        );
      } catch (error) {
        console.error('[startup] Failed to reinstall addon dependencies:', error);
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
    setSplashTargetWindow(null);
    // Ensure splash window is closed if it was created
    closeSplashWindow();
  }
}
