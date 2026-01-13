import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { checkIfInstallerUpdateAvailable } from './updater.js';
import { restoreBackup, removeCachedAppUpdates } from './startup.js';
import { execute as executeMigrations } from './migrations.js';
import { isDev } from './manager/manager.paths.js';

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
      preload: isDev()
        ? join(app.getAppPath(), 'splash-preload.mjs')
        : join(app.getAppPath(), 'build/splash-preload.mjs'),
    },
  });
  splash.loadURL('file://' + join(app.getAppPath(), 'public', 'splash.html'));
  splash.once('ready-to-show', () => {
    splash.show();
  });
  return splash;
}

/**
 * Updates the splash screen's status message shown to the user.
 *
 * @param text - The status message to display on the splash screen; does nothing if the splash window is not present or has been destroyed
 */
function updateSplashStatus(text: string) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-status', text);
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
 */
export async function runStartupTasks(): Promise<void> {
  // Show splash screen immediately
  splashWindow = createSplashWindow();

  // Restore backup if it exists
  updateSplashStatus('Restoring backup...');
  restoreBackup();

  // Run any migrations if necessary
  updateSplashStatus('Running migrations...');
  executeMigrations();

  // Remove cached app updates
  updateSplashStatus('Cleaning up...');
  removeCachedAppUpdates();

  // Check for installer/setup updates
  updateSplashStatus('Checking for updates...');
  await checkIfInstallerUpdateAvailable();

  // Final status before main window loads
  updateSplashStatus('Starting application...');
}