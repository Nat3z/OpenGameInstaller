import { app, BrowserWindow } from 'electron';
import { join } from 'path';
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

let splashWindow: BrowserWindow | null = null;

/**
 * Creates and returns a configured splash screen BrowserWindow used during app startup.
 *
 * The window is frameless, non-resizable, always-on-top, and loads the bundled splash HTML; the preload script path is chosen based on development vs production mode.
 *
 * @returns The created splash-screen BrowserWindow
 */
function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 300,
    height: 350,
    frame: false,
    resizable: false,
    transparent: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      devTools: false,
      preload: join(app.getAppPath(), 'out/preload/splash.mjs'),
    },
  });
  splash.loadURL('file://' + join(app.getAppPath(), 'public', 'splash.html'));
  splash.once('ready-to-show', () => {
    splash.show();
  });
  return splash;
}

/** When set, splash updates are sent to this window (single-window / Steam Deck flow). */
let splashTargetWindow: BrowserWindow | null = null;

/**
 * Updates the splash screen's status message shown to the user.
 *
 * @param text - The status message to display on the splash screen
 * @param subtext - Optional secondary text (e.g., download speed, file name)
 */
function updateSplashStatus(text: string, subtext?: string) {
  if (splashTargetWindow && !splashTargetWindow.isDestroyed()) {
    splashTargetWindow.webContents.send('splash-status', text, subtext);
  }
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-status', text, subtext);
  }
}

/**
 * Updates the splash screen's progress bar.
 *
 * @param current - Current progress value
 * @param total - Total/maximum progress value
 * @param speed - Optional speed text (e.g., "1.5MB/s")
 */
function updateSplashProgress(current: number, total: number, speed?: string) {
  if (splashTargetWindow && !splashTargetWindow.isDestroyed()) {
    splashTargetWindow.webContents.send('splash-progress', current, total, speed);
  }
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-progress', current, total, speed);
  }
}

/**
 * Closes the currently open splash window and clears the internal reference.
 *
 * If no splash window is present or it has already been destroyed, the function does nothing.
 */
export function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

/**
 * Runs all pre-launch startup tasks with splash screen feedback.
 * This includes restoring backups, running migrations, checking for updates, etc.
 *
 * When mainWindow is passed (single-window / Steam Deck Game Mode flow), splash
 * status is sent to that window only; no separate splash window is created.
 * This keeps one window so Steam focuses the same window throughout.
 *
 * @param mainWindow - Optional. When provided, use this window for splash UI instead of creating a separate splash window.
 */
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
  }
}
