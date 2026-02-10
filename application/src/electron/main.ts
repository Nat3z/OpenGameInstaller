import { join } from 'path';
import { server, port } from './server/addon-server.js';
import { applicationAddonSecret } from './server/constants.js';
import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron';
import fs, { existsSync, readFileSync } from 'fs';
import { processes } from './manager/manager.addon.js';
import { stopClient } from './manager/manager.webtorrent.js';
import type { ConfigurationFile } from 'ogi-addon/config';
import AppEventHandler from './handlers/handler.app.js';
import FSEventHandler from './handlers/handler.fs.js';
import RealdDebridHandler from './handlers/handler.realdebrid.js';
import TorrentHandler from './handlers/handler.torrent.js';
import DirectDownloadHandler from './handlers/handler.ddl.js';
import AddonRestHandler from './handlers/handler.rest.js';
import { __dirname, isDev } from './manager/manager.paths.js';
import {
  checkForAddonUpdates,
  convertLibrary,
  IS_NIXOS,
  STEAMTINKERLAUNCH_PATH,
} from './startup.js';
import AddonManagerHandler, { startAddons } from './handlers/handler.addon.js';
import OOBEHandler from './handlers/handler.oobe.js';
import { runStartupTasks, closeSplashWindow } from './startup-runner.js';
// import steamworks from 'steamworks.js';

export const VERSION = app.getVersion();

// Register once at module load so it is safe on window re-creation (e.g. macOS activate).
ipcMain.removeHandler('get-version');
ipcMain.handle('get-version', () => VERSION);

const DEV_APP_ORIGIN = 'http://localhost:8080';

export let isSecurityCheckEnabled = true;
if (existsSync(join(__dirname, 'config/option/developer.json'))) {
  const developerConfig = JSON.parse(
    readFileSync(join(__dirname, 'config/option/developer.json'), 'utf-8')
  );
  isSecurityCheckEnabled = developerConfig.disableSecretCheck !== true;
  if (!isSecurityCheckEnabled) {
    for (let i = 0; i < 10; i++) {
      console.warn(
        'WARNING Security check is disabled. THIS IS A MAJOR SECURITY RISK. PLEASE ENABLE DURING NORMAL USE.'
      );
    }
  }
}
// check if NixOS using command -v nixos-rebuild
console.log('continuing launch...');
console.log('NIXOS: ' + IS_NIXOS);
if (IS_NIXOS) {
  console.log(
    'NixOS detected, but startup logic has been moved. If you have issues, please check startup.ts'
  );
}
if (STEAMTINKERLAUNCH_PATH === '') {
  console.error(
    'STEAMTINKERLAUNCH_PATH is empty. This should be handled in startup.ts'
  );
}

console.log('STEAMTINKERLAUNCH_PATH: ' + STEAMTINKERLAUNCH_PATH);
console.log('Running in directory: ' + __dirname);

export let torrentIntervals: NodeJS.Timeout[] = [];

let mainWindow: BrowserWindow | null;

interface Notification {
  message: string;
  id: string;
  type: 'info' | 'error' | 'success' | 'warning';
}
export function sendNotification(notification: Notification) {
  sendIPCMessage('notification', notification);
}

let isReadyForEvents = false;

let readyForEventWaiters: (() => void)[] = [];

export async function sendIPCMessage(channel: string, ...args: any[]) {
  if (!isReadyForEvents) {
    await new Promise<void>((resolve) => {
      console.log('waiting for events');
      readyForEventWaiters.push(resolve);
    });
    console.log('events ready');
  }
  mainWindow?.webContents.send(channel, ...args);
}

export let currentScreens = new Map<
  string,
  { [key: string]: string | boolean | number } | undefined
>();

export function sendAskForInput(
  id: string,
  config: ConfigurationFile,
  name: string,
  description: string
) {
  if (!mainWindow) {
    console.error('Main window is not ready yet. Cannot send ask for input.');
    return;
  }
  if (!mainWindow.webContents) {
    console.error(
      'Main window web contents is not ready yet. Cannot send ask for input.'
    );
    return;
  }
  mainWindow.webContents.send('input-asked', { id, config, name, description });
  currentScreens.set(id, undefined);
}

/**
 * Single-window flow for Steam Deck / Game Mode: one BrowserWindow shows splash first, then the main app.
 * This avoids Steam focusing a separate splash window and leaving the main window black.
 */

const ogiDebug = () => (process.env.OGI_DEBUG ?? 'false') === 'true';

/**
 * Runs when the main app page has finished loading in the main window (second ready-to-show).
 */
function onMainAppReady() {
  if (!mainWindow) {
    console.error('onMainAppReady called but mainWindow is null');
    return;
  }
  closeSplashWindow();

  AppEventHandler(mainWindow);
  FSEventHandler();
  RealdDebridHandler(mainWindow);
  TorrentHandler(mainWindow);
  DirectDownloadHandler(mainWindow);
  AddonRestHandler();
  AddonManagerHandler(mainWindow);
  OOBEHandler();

  console.log('showing window');
  mainWindow.show();
  mainWindow.focus();

  checkForAddonUpdates(mainWindow);
  if (ogiDebug()) {
    mainWindow.webContents.openDevTools();
  }
  if (!isSecurityCheckEnabled) {
    sendNotification({
      message:
        "Security checks are disabled and application security LOWERED. Only enable if you know what you're doing.",
      id: Math.random().toString(36).substring(7),
      type: 'warning',
    });
  }

  convertLibrary();

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        shell.openExternal(details.url);
      } else {
        console.warn('Blocked external open for non-http(s) URL:', details.url);
      }
    } catch {
      console.warn('Blocked external open for malformed URL:', details.url);
    }
    return { action: 'deny' };
  });
}

/**
 * Loads the main app into the existing main window after splash: runs startup tasks,
 * then loads the app URL and wires onMainAppReady. Used by both app.on('ready') and
 * app.on('activate') on macOS when the window is re-created.
 */
async function loadMainAppIntoWindow(): Promise<void> {
  if (!mainWindow) {
    console.error('loadMainAppIntoWindow called but mainWindow is null');
    return;
  }
  await runStartupTasks(mainWindow);
  if (!mainWindow) {
    console.error('mainWindow was closed during startup tasks');
    return;
  }
  if (isDev()) {
    mainWindow.loadURL(
      DEV_APP_ORIGIN + '/?secret=' + applicationAddonSecret
    );
    console.log('Running in development');
  } else {
    mainWindow.loadURL(
      'file://' +
        join(app.getAppPath(), 'out', 'renderer', 'index.html') +
        '?secret=' +
        applicationAddonSecret
    );
  }
  mainWindow.once('ready-to-show', onMainAppReady);
}

/**
 * Creates the main BrowserWindow, loads splash first, then caller loads the app and registers onMainAppReady.
 * Single-window flow so Steam Deck / Game Mode keeps focus on the same window.
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: ogiDebug() || isDev(),
      preload: join(app.getAppPath(), 'out/preload/index.mjs'),
    },
    title: 'OpenGameInstaller',
    fullscreenable: false,
    resizable: false,
    icon: join(app.getAppPath(), 'public/favicon.ico'),
    autoHideMenuBar: true,
    show: false,
  });
  if (!isDev() && !ogiDebug()) mainWindow.removeMenu();

  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

  // Load splash first so there is only one window (fixes Steam Deck Game Mode black screen)
  mainWindow.loadURL(
    'file://' + join(app.getAppPath(), 'public', 'splash.html')
  );

  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  fs.mkdir(join(__dirname, 'config'), (_) => {});

  // First ready-to-show: splash is ready; show window so user sees loading
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  // One-time app-level listeners so they do not stack on window re-creation (e.g. macOS activate)
  ipcMain.on('client-ready-for-events', () => {
    isReadyForEvents = true;
    for (const waiter of readyForEventWaiters) {
      waiter();
    }
    readyForEventWaiters = [];
  });

  app.on('browser-window-focus', () => {
    globalShortcut.register('CommandOrControl+R', () => {
      console.log('CommandOrControl+R is pressed: Shortcut Disabled');
    });
    globalShortcut.register('F5', () => {
      console.log('F5 is pressed: Shortcut Disabled');
    });
  });
  app.on('browser-window-blur', () => {
    globalShortcut.unregister('CommandOrControl+R');
    globalShortcut.unregister('F5');
  });
  app.on('web-contents-created', (_, contents) => {
    contents.on('devtools-opened', () => {
      if (!isDev() && !ogiDebug()) contents.closeDevTools();
    });
    contents.on('will-navigate', (event, navigationUrl) => {
      try {
        const parsedUrl = new URL(navigationUrl);
        // Packaged: allow only file:. Dev: allow file: and DEV_APP_ORIGIN (Node reports file: origin as "null")
        const allowed =
          parsedUrl.protocol === 'file:' ||
          (isDev() && parsedUrl.origin === DEV_APP_ORIGIN);

        if (!allowed) {
          event.preventDefault();
          console.warn(
            'Blocked navigation to disallowed origin:',
            navigationUrl,
            isDev()
              ? '(allowed: file:, ' + DEV_APP_ORIGIN + ')'
              : '(allowed: file: only)'
          );
        }
      } catch {
        event.preventDefault();
        console.warn('Blocked navigation to malformed URL:', navigationUrl);
      }
    });
  });

  // Single window: create it and show splash first so Steam Deck / Game Mode keeps focus
  createWindow();
  await loadMainAppIntoWindow();

  server.listen(port, () => {
    console.log(`Addon Server is running on http://localhost:${port}`);
    console.log(`Server is being executed by electron!`);
  });

  sendNotification({
    message: 'Addons Starting...',
    id: Math.random().toString(36).substring(7),
    type: 'success',
  });

  startAddons();
});

// Quit when all windows are closed.
app.on('window-all-closed', async function () {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') app.quit();
  // stop torrenting
  console.log('Stopping torrent client...');
  await stopClient();
  // stop the server
  console.log('Stopping server...');
  server.close();
  // stop all of the addons
  for (const process of Object.keys(processes)) {
    console.log(`Killing process ${process}`);
    processes[process].kill('SIGKILL');
  }
  // stopping all of the torrent intervals
  for (const interval of torrentIntervals) {
    clearInterval(interval);
  }

  // now stop the application completely
  app.exit(0);
});

app.on('activate', async () => {
  // On macOS it's common to re-create a window when the dock icon is clicked and there are no other windows open.
  // Re-run the full flow: create window (splash), then load main app so the user does not get stuck on splash.
  if (mainWindow === null) {
    createWindow();
    await loadMainAppIntoWindow();
  }
});
