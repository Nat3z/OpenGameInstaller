import { app, BrowserWindow } from 'electron';
import { join } from 'path';

let splashWindow: BrowserWindow | null = null;

/** When set, splash updates are sent to this window (single-window / Steam Deck flow). */
let splashTargetWindow: BrowserWindow | null = null;

export function setSplashTargetWindow(win: BrowserWindow | null): void {
  splashTargetWindow = win;
}

export function setSplashWindow(win: BrowserWindow | null): void {
  splashWindow = win;
}

function getSplashWindow(): BrowserWindow | null {
  const w = splashTargetWindow ?? splashWindow;
  return w && !w.isDestroyed() ? w : null;
}

/**
 * Creates and returns a configured splash screen BrowserWindow used during app startup.
 *
 * @returns The created splash-screen BrowserWindow
 */
export function createSplashWindow(): BrowserWindow {
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

export function updateSplashStatus(text: string, subtext?: string): void {
  const w = getSplashWindow();
  if (w?.webContents) w.webContents.send('splash-status', text, subtext);
}

export function updateSplashProgress(
  current: number,
  total: number,
  speed: string
): void {
  const w = getSplashWindow();
  if (w?.webContents)
    w.webContents.send('splash-progress', current, total, speed);
}

/**
 * Closes the dedicated splash window if one was created (e.g. legacy flow).
 * Called from main when the main app is ready and from startup-runner finally block.
 */
export function closeSplashWindow(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}
