import { join } from 'path';
import { server, port } from './server/addon-server.js';
import { applicationAddonSecret } from './server/constants.js';
import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron';
import fs, { existsSync, readFileSync } from 'fs';
import { processes } from './manager/manager.addon.js';
import { stopClient } from './manager/manager.webtorrent.js';
import { ConfigurationFile } from 'ogi-addon/build/config/ConfigurationBuilder.js';
import { checkIfInstallerUpdateAvailable } from './updater.js';
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
  removeCachedAppUpdates,
  restoreBackup,
  STEAMTINKERLAUNCH_PATH,
} from './startup.js';
import AddonManagerHandler, { startAddons } from './handlers/handler.addon.js';
import OOBEHandler from './handlers/handler.oobe.js';
import { execute as executeMigrations } from './migrations.js';
import steamworks from 'steamworks.js';

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
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow: BrowserWindow | null;

// restore the backup if it exists
restoreBackup();

// run any migrations if necessary
executeMigrations();

// remove cached app updates
removeCachedAppUpdates();

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
    // wait for main window to be ready
    // wait for the main window to be ready with a callback
    await new Promise<void>((resolve) => {
      console.log('waiting for events');
      readyForEventWaiters.push(resolve);
    });
    // wait for 500ms before checking again
    await new Promise((resolve) => setTimeout(resolve, 500));
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

function createWindow() {
  // Create the browser window.
  // check if the environment variable OGI_DEBUG is set, and if so, allow devtools
  const ogiDebug = process.env.OGI_DEBUG ?? 'false';
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      // always allow devtools
      devTools: ogiDebug === 'true' || isDev(),
      preload: isDev()
        ? join(app.getAppPath(), 'preload.mjs')
        : join(app.getAppPath(), 'build/preload.mjs'),
    },
    title: 'OpenGameInstaller',
    fullscreenable: false,
    resizable: false,
    icon: join(app.getAppPath(), 'public/favicon.ico'),
    autoHideMenuBar: true,
    show: false,
  });
  if (ogiDebug === 'true') {
    // open devtools
    mainWindow.webContents.openDevTools();
  }
  if (!isDev() && ogiDebug !== 'true') mainWindow.removeMenu();

  // This block of code is intended for development purpose only.
  // Delete this entire block of code when you are ready to package the application.

  ipcMain.on('client-ready-for-events', async () => {
    isReadyForEvents = true;
    for (const waiter of readyForEventWaiters) {
      waiter();
    }
    readyForEventWaiters = [];
  });

  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
  let steamworksClient: ReturnType<typeof steamworks.init> | null = null;

  // non-blocking way to initialize steamworks
  new Promise<void>((resolve) => {
    try {
      steamworksClient = steamworks.init(isDev() ? 480 : undefined);
    } catch (error) {
      console.error('Failed to initialize Steamworks:', error);
      steamworksClient = null;
    }
    resolve();
  });

  ipcMain.handle(
    'app:open-steam-keyboard',
    async (
      _,
      {
        x,
        y,
        width,
        height,
      }: { x: number; y: number; width: number; height: number }
    ): Promise<boolean> => {
      if (!steamworksClient) {
        return false;
      }
      // Check if running on Steam Deck or in Big Picture mode
      // if (!steamworksClient.utils.isSteamRunningOnSteamDeck()) {
      //   return false;
      // }

      // Show the Steam keyboard overlay
      // The keyboard will inject text directly into the focused input element
      return steamworksClient.utils
        .showFloatingGamepadTextInput(
          0, // Single line
          x,
          y,
          width,
          height
        )
        .then((result) => {
          return result;
        })
        .catch((error) => {
          console.error('Failed to show Steam keyboard:', error);
          return false;
        });
    }
  );

  if (isDev()) {
    mainWindow!!.loadURL(
      'http://localhost:8080/?secret=' + applicationAddonSecret
    );
    console.log('Running in development');
  } else {
    mainWindow!!.loadURL(
      'file://' +
        join(app.getAppPath(), 'public', 'index.html') +
        '?secret=' +
        applicationAddonSecret
    );
  }

  // Uncomment the following line of code when app is ready to be packaged.
  // loadURL(mainWindow);

  // Open the DevTools and also disable Electron Security Warning.
  // process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = true;
  // mainWindow.webContents.openDevTools();

  // Emitted when the window is closed.
  mainWindow.on('closed', function () {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null;
  });

  // Emitted when the window is ready to be shown
  // This helps in showing the window gracefully.
  fs.mkdir(join(__dirname, 'config'), (_) => {});
  mainWindow.once('ready-to-show', () => {
    AppEventHandler(mainWindow!!);
    FSEventHandler();
    RealdDebridHandler(mainWindow!!);
    TorrentHandler(mainWindow!!);
    DirectDownloadHandler(mainWindow!!);
    AddonRestHandler();
    AddonManagerHandler(mainWindow!!);
    OOBEHandler();

    ipcMain.on('get-version', async (event) => {
      event.returnValue = VERSION;
    });
    console.log('showing window');
    mainWindow!!.show();
    // start the app with it being focused
    mainWindow!!.focus();

    if (mainWindow) {
      checkForAddonUpdates(mainWindow);
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

    app.on('browser-window-focus', function () {
      globalShortcut.register('CommandOrControl+R', () => {
        console.log('CommandOrControl+R is pressed: Shortcut Disabled');
      });
      globalShortcut.register('F5', () => {
        console.log('F5 is pressed: Shortcut Disabled');
      });
    });

    mainWindow!!.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: 'deny' };
    });

    app.on('browser-window-blur', function () {
      globalShortcut.unregister('CommandOrControl+R');
      globalShortcut.unregister('F5');
    });

    // disable devtools
    mainWindow!!.webContents.on('devtools-opened', () => {
      if (!isDev() && process.env.OGI_DEBUG !== 'true')
        mainWindow!!.webContents.closeDevTools();
    });

    app.on('web-contents-created', (_, contents) => {
      contents.on('will-navigate', (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);

        if (
          parsedUrl.origin !== 'http://localhost:8080' &&
          parsedUrl.origin !== 'file://'
        ) {
          event.preventDefault();
          throw new Error('Navigating to that address is not allowed.');
        }
      });
    });
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  // check updates for setup
  await checkIfInstallerUpdateAvailable();

  createWindow();
  server.listen(port, () => {
    console.log(`Addon Server is running on http://localhost:${port}`);
    console.log(`Server is being executed by electron!`);
  });

  setTimeout(() => {
    sendNotification({
      message: 'Addons Starting...',
      id: Math.random().toString(36).substring(7),
      type: 'success',
    });

    startAddons();
  }, 1500);
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
});

app.on('activate', function () {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) createWindow();
});
