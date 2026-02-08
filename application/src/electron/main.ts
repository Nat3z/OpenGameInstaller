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
import AllDebridHandler from './handlers/handler.alldebrid.js';
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

// Flag to ensure process-wide listeners are registered only once
let listenersRegistered = false;

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
  closeSplashWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  AppEventHandler(mainWindow);
  FSEventHandler();
  RealdDebridHandler(mainWindow);
  AllDebridHandler(mainWindow);
  TorrentHandler(mainWindow);
  DirectDownloadHandler(mainWindow);
  AddonRestHandler();
  AddonManagerHandler(mainWindow);
  OOBEHandler();

  // Register process-wide listeners only once
  if (!listenersRegistered) {
    listenersRegistered = true;

    ipcMain.on('get-version', async (event) => {
      event.returnValue = VERSION;
    });

    app.on('browser-window-focus', function () {
      globalShortcut.register('CommandOrControl+R', () => {
        console.log('CommandOrControl+R is pressed: Shortcut Disabled');
      });
      globalShortcut.register('F5', () => {
        console.log('F5 is pressed: Shortcut Disabled');
      });
    });

    app.on('browser-window-blur', function () {
      globalShortcut.unregister('CommandOrControl+R');
      globalShortcut.unregister('F5');
    });
  }

  console.log('showing window');
  mainWindow?.show();
  mainWindow?.focus();

  if (mainWindow && !mainWindow.isDestroyed()) {
    checkForAddonUpdates(mainWindow);
  }
  if (ogiDebug()) {
    mainWindow?.webContents?.openDevTools();
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

  mainWindow?.webContents?.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  mainWindow?.webContents?.on('devtools-opened', () => {
    if (!isDev() && !ogiDebug()) mainWindow?.webContents?.closeDevTools();
  });
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
      nodeIntegration: true,
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

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(navigationUrl);
    } catch {
      event.preventDefault();
      console.error('Blocked navigation to malformed URL:', navigationUrl);
      return;
    }

    if (
      parsedUrl.origin !== 'http://localhost:8080' &&
      parsedUrl.protocol !== 'file:'
    ) {
      event.preventDefault();
      console.warn(`Blocked navigation to: ${navigationUrl}`);
    }
  });

  if (!isDev() && !ogiDebug()) mainWindow.removeMenu();

  ipcMain.on('client-ready-for-events', async () => {
    isReadyForEvents = true;
    for (const waiter of readyForEventWaiters) {
      waiter();
    }
    readyForEventWaiters = [];
  });

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

async function startAppFlow(win: BrowserWindow) {
  // Run startup tasks; splash updates go to the main window
  if (win && !win.isDestroyed()) {
    await runStartupTasks(win);
  }

  // Load the main app into the same window (replaces splash)
  if (win && !win.isDestroyed()) {
    if (isDev()) {
      win.loadURL(
        'http://localhost:8080/?secret=' + applicationAddonSecret
      );
      console.log('Running in development');
    } else {
      win.loadURL(
        'file://' +
          join(app.getAppPath(), 'out', 'renderer', 'index.html') +
          '?secret=' +
          applicationAddonSecret
      );
    }
    win.once('ready-to-show', onMainAppReady);
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  // Single window: create it and show splash first so Steam Deck / Game Mode keeps focus
  createWindow();

  if (mainWindow) {
    await startAppFlow(mainWindow);
  }

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

app.on('activate', async function () {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
    if (mainWindow) await startAppFlow(mainWindow);
  }
});
