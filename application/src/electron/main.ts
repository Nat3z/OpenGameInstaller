import { join } from 'path';
import { server, port } from './server/addon-server.js';
import { applicationAddonSecret } from './server/constants.js';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from 'electron';
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
import { registerLibraryHandlers } from './handlers/handler.library.js';
import { registerSteamHandlers } from './handlers/handler.steam.js';
import { registerUmuHandlers } from './handlers/handler.umu.js';
import { registerRedistributableHandlers } from './handlers/handler.redists.js';
// import steamworks from 'steamworks.js';

/**
 * Parse command line arguments for --game-id flag
 * This is used when launching from Steam shortcuts
 */
function parseGameIdArg(): number | null {
  const gameIdArg = process.argv.find((arg) => arg.startsWith('--game-id='));
  if (gameIdArg) {
    const gameId = parseInt(gameIdArg.split('=')[1], 10);
    if (!isNaN(gameId)) {
      return gameId;
    }
  }
  return null;
}

/**
 * Launch a game directly by ID (used from Steam shortcuts)
 */
async function launchGameById(gameId: number) {
  console.log(`[launch] Launching game by ID: ${gameId}`);

  // Create a minimal window showing "Launching..."
  const launchWindow = new BrowserWindow({
    width: 400,
    height: 200,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'Launching...',
    fullscreenable: false,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    center: true,
    show: false,
  });

  // Load a simple HTML page showing launching status
  const launchingHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      background: #1a1a1a;
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #333;
      border-top-color: #4CAF50;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 20px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .text {
      font-size: 16px;
      opacity: 0.9;
    }
    .game-name {
      font-size: 14px;
      opacity: 0.6;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <div class="text">Launching game...</div>
  <div class="game-name" id="gameName">Please wait</div>
  <script>
    // Auto-close after 5 seconds (game should be launching by then)
    setTimeout(() => {
      window.close();
    }, 5000);
  </script>
</body>
</html>`;

  launchWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(launchingHtml));

  launchWindow.once('ready-to-show', () => {
    launchWindow.show();
  });

  // Wait a moment for the window to show, then launch the game
  setTimeout(async () => {
    try {
      // Import the library handler function
      const { loadLibraryInfo } = await import('./handlers/helpers.app/library.js');
      const { launchWithUmu } = await import('./handlers/handler.umu.js');

      const libraryInfo = loadLibraryInfo(gameId);

      if (!libraryInfo) {
        console.error(`[launch] Game not found: ${gameId}`);
        launchWindow.close();
        app.quit();
        return;
      }

      // Update the UI with the game name
      launchWindow.webContents.executeJavaScript(`
        document.getElementById('gameName').textContent = ${JSON.stringify(libraryInfo.name)};
      `);

      // Check if this is a UMU game
      if (libraryInfo.umu) {
        const result = await launchWithUmu(libraryInfo);
        if (!result.success) {
          console.error('[launch] Failed to launch game:', result.error);
        }
      } else {
        const msg = `[launch] Game is not in UMU mode, cannot launch from Steam shortcut: ${libraryInfo.name}`;
        console.error(msg);
        dialog.showErrorBox('Launch Failed', `${libraryInfo.name} is not configured for UMU Steam shortcut launching.`);
      }

      // Close the launch window after a short delay
      setTimeout(() => {
        launchWindow.close();
        app.quit();
      }, 2000);
    } catch (error) {
      console.error('[launch] Error launching game:', error);
      launchWindow.close();
      app.quit();
    }
  }, 500);
}

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

/* Sync IPC for initial theme: must be registered before renderer loads to avoid flash */
ipcMain.on('get-initial-theme', (event) => {
  try {
    const configPath = join(__dirname, 'config/option/general.json');
    if (existsSync(configPath)) {
      const data = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        theme?: string;
      };
      const t = data.theme;
      event.returnValue = t === 'dark' || t === 'synthwave' ? t : 'light';
    } else {
      event.returnValue = 'light';
    }
  } catch {
    event.returnValue = 'light';
  }
});

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
  // If no renderer window is available (e.g., --game-id launch path), skip IPC dispatch
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

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
let handlersRegistered = false;

function onMainAppReady() {
  closeSplashWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Guard handler registrations to run only once
  if (!handlersRegistered) {
    handlersRegistered = true;
    AppEventHandler(mainWindow);
    FSEventHandler();
    RealdDebridHandler(mainWindow);
    AllDebridHandler(mainWindow);
    TorrentHandler(mainWindow);
    DirectDownloadHandler(mainWindow);
    AddonRestHandler();
    AddonManagerHandler(mainWindow);
    OOBEHandler();
    // Register new UMU and updated handlers
    registerLibraryHandlers(mainWindow);
    registerSteamHandlers();
    registerUmuHandlers();
    registerRedistributableHandlers();
  }

  // Register process-wide listeners only once
  if (!listenersRegistered) {
    listenersRegistered = true;

    ipcMain.on('get-version', async (event) => {
      event.returnValue = VERSION;
    });

    ipcMain.on('is-dev', async (event) => {
      event.returnValue = isDev();
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
      win.loadURL('http://localhost:8080/?secret=' + applicationAddonSecret);
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
  // Check if we're launching a specific game (--game-id flag from Steam)
  const gameIdToLaunch = parseGameIdArg();
  if (gameIdToLaunch !== null) {
    console.log(`[app] Steam shortcut launch detected for game ${gameIdToLaunch}`);
    await launchGameById(gameIdToLaunch);
    return;
  }

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
  if (process.platform === 'darwin') {
    return;
  }

  // Perform cleanup before quitting
  try {
    // stop torrenting
    console.log('Stopping torrent client...');
    await stopClient();

    // stop the server
    console.log('Stopping server...');
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });

    // stop all of the addons
    for (const process of Object.keys(processes)) {
      console.log(`Killing process ${process}`);
      processes[process].kill('SIGKILL');
    }

    // stopping all of the torrent intervals
    for (const interval of torrentIntervals) {
      clearInterval(interval);
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
  }

  // Now quit the application
  app.quit();
});

app.on('activate', async function () {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
    if (mainWindow) await startAppFlow(mainWindow);
  }
});
