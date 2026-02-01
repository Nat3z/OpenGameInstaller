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
import { execute as executeMigrations } from './migrations.js';

/**
 * Updates the splash UI's status message (sent to the main window when it is showing splash content).
 *
 * @param splashTarget - The window whose webContents is currently showing splash.html
 * @param text - The status message to display
 * @param subtext - Optional secondary text (e.g., download speed, file name)
 */
function updateSplashStatus(
  splashTarget: BrowserWindow | null,
  text: string,
  subtext?: string
) {
  if (splashTarget && !splashTarget.isDestroyed()) {
    splashTarget.webContents.send('splash-status', text, subtext);
  }
}

/**
 * Updates the splash UI's progress bar.
 *
 * @param splashTarget - The window whose webContents is currently showing splash.html
 * @param current - Current progress value
 * @param total - Total/maximum progress value
 * @param speed - Optional speed text (e.g., "1.5MB/s")
 */
function updateSplashProgress(
  splashTarget: BrowserWindow | null,
  current: number,
  total: number,
  speed?: string
) {
  if (splashTarget && !splashTarget.isDestroyed()) {
    splashTarget.webContents.send('splash-progress', current, total, speed);
  }
}

/**
 * No-op for single-window flow: splash is shown in the main window, so there is no separate window to close.
 * Kept for API compatibility with main.ts.
 */
export function closeSplashWindow() {
  // Single-window flow: splash is part of the main window; nothing to close.
}

/**
 * Runs all pre-launch startup tasks with splash feedback in the given window.
 * The window should already be loading or showing splash.html so status/progress can be sent to it.
 * This includes restoring backups, running migrations, checking for updates, etc.
 *
 * @param splashTarget - The BrowserWindow currently displaying splash content (same window that will later show the app)
 */
export async function runStartupTasks(
  splashTarget: BrowserWindow
): Promise<void> {

  // Restore backup if it exists
  updateSplashStatus(splashTarget, 'Restoring backup...');
  const backupResult = await restoreBackup((file, current, total) => {
    updateSplashStatus(splashTarget, 'Restoring backup', `${file} (${current}/${total})`);
    updateSplashProgress(splashTarget, current, total, '');
  });

  // Run any migrations if necessary
  updateSplashStatus(splashTarget, 'Running migrations...');
  // not async because it relies on the app being open
  executeMigrations();

  // Remove cached app updates
  updateSplashStatus(splashTarget, 'Cleaning up...');
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
    updateSplashStatus(splashTarget, 'Reinstalling addon dependencies...');
    try {
      await reinstallAddonDependencies((addonName, current, total) => {
        updateSplashStatus(
          splashTarget,
          'Installing addon dependencies',
          `${addonName} (${current}/${total})`
        );
        updateSplashProgress(splashTarget, current, total, '');
      });
    } catch (error) {
      console.error('[startup] Failed to reinstall addon dependencies:', error);
      // Continue anyway - addons may still work or can be reinstalled later
    }
  }

  // Check for installer/setup updates with splash screen callbacks
  updateSplashStatus(splashTarget, 'Checking for updates...');
  const updaterCallbacks: UpdaterCallbacks = {
    onStatus: (text: string, subtext?: string) => {
      updateSplashStatus(splashTarget, text, subtext);
    },
    onProgress: (current: number, total: number, speed: string) => {
      updateSplashProgress(splashTarget, current, total, speed);
    },
  };
  await checkIfInstallerUpdateAvailable(updaterCallbacks);

  // Final status before main app loads in the same window
  updateSplashStatus(splashTarget, 'Starting application...');
}
