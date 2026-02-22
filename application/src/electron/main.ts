import { join } from 'path';
import { quote as shellQuote } from 'shell-quote';
import {
  addonServer,
  registerInstanceBridgeHandlers,
  server,
  port,
  type LaunchForwardPayload,
} from './server/addon-server.js';
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
import { registerUmuHandlers } from './handlers/handler.umu.js';
import {
  executeWrapperCommandForApp,
  launchGameFromLibrary,
} from './handlers/handler.library.js';
import { loadLibraryInfo } from './handlers/helpers.app/library.js';
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
 * Parse command line arguments for launch hook flags
 * --no-launch: Don't actually launch the game
 * --pre: Run pre-launch hooks
 * --post: Run post-launch hooks
 */
function parseLaunchHookArgs(): {
  noLaunch: boolean;
  runPre: boolean;
  runPost: boolean;
} {
  return {
    noLaunch: process.argv.includes('--no-launch'),
    runPre: process.argv.includes('--pre'),
    runPost: process.argv.includes('--post'),
  };
}

/**
 * Parse wrapper command from args after a `--` separator.
 * Everything after `--` is treated as the wrapper command payload.
 * Each argument is shell-quoted so paths with spaces survive round-trip
 * when the string is later parsed in the library handler.
 */
function parseWrapperAfterSeparator(): string | null {
  const separatorIndex = process.argv.indexOf('--');
  if (separatorIndex === -1 || separatorIndex >= process.argv.length - 1) {
    return null;
  }

  const args = process.argv.slice(separatorIndex + 1);
  return args.map((arg) => shellQuote([arg])).join(' ');
}

const INSTANCE_BRIDGE_BASE_URL = `http://127.0.0.1:${port}/internal`;
const INSTANCE_BRIDGE_TIMEOUT_MS = 1500;

function buildLaunchForwardPayload(
  gameId: number,
  hookArgs: ReturnType<typeof parseLaunchHookArgs>,
  wrapperCommand: string | null
): LaunchForwardPayload {
  return {
    gameId,
    noLaunch: hookArgs.noLaunch,
    runPre: hookArgs.runPre,
    runPost: hookArgs.runPost,
    wrapperCommand,
    originalArgv: process.argv.slice(1),
  };
}

async function requestRunningInstance(
  path: string,
  init: RequestInit = {}
): Promise<Response | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, INSTANCE_BRIDGE_TIMEOUT_MS);

  try {
    return await fetch(`${INSTANCE_BRIDGE_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function isRunningInstanceAvailable(): Promise<boolean> {
  const response = await requestRunningInstance('/ping');
  if (!response?.ok) {
    return false;
  }

  try {
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function requestRunningInstanceFocus(): Promise<boolean> {
  const response = await requestRunningInstance('/focus', {
    method: 'POST',
  });
  return response?.ok === true;
}

async function forwardLaunchToRunningInstance(
  payload: LaunchForwardPayload
): Promise<boolean> {
  const response = await requestRunningInstance('/launch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return response?.ok === true;
}

/**
 * Handle launch hooks (pre/post) for games
 * This runs addon events without actually launching the game
 * Used for save backup/restore and other addon-managed tasks
 */
async function handleLaunchHooks(
  gameId: number,
  hookType: 'pre' | 'post'
): Promise<void> {
  console.log(
    `[launch-hooks] Running ${hookType}-launch hooks for game ${gameId}`
  );

  // Create main window to show the launch screen
  createWindow({ gameLaunchMode: true });

  if (mainWindow) {
    registerMainHandlers(mainWindow);
    await startAddonRuntime();
    await runStartupTasks(mainWindow);

    // Load the main app with game ID and hook flags
    const baseUrl = isDev()
      ? `http://localhost:8080/?secret=${applicationAddonSecret}`
      : `file://${join(app.getAppPath(), 'out', 'renderer', 'index.html')}?secret=${applicationAddonSecret}`;

    // Add flags to indicate this is a hook-only launch
    const launchUrl = `${baseUrl}&launchGameId=${gameId}&hookType=${hookType}&noLaunch=true`;

    await mainWindow.loadURL(launchUrl);

    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
      onMainAppReady();
    });
  }
}

/**
 * Launch a game directly by ID (used from Steam shortcuts)
 * Now integrated into the main Svelte UI via query parameters
 */
async function launchGameById(gameId: number, wrapperCommand?: string | null) {
  console.log(
    `[launch] Steam shortcut launch detected for game ${gameId}, loading into main UI`
  );

  // Single window: create main window and pass game ID via query param
  createWindow({ gameLaunchMode: true });

  if (mainWindow) {
    registerMainHandlers(mainWindow);
    await startAddonRuntime();
    // Run startup tasks first
    await runStartupTasks(mainWindow);

    // Load the main app with the game ID in the query params
    // The Svelte frontend will detect this and show the GameLaunchOverlay
    const baseUrl = isDev()
      ? `http://localhost:8080/?secret=${applicationAddonSecret}`
      : `file://${join(app.getAppPath(), 'out', 'renderer', 'index.html')}?secret=${applicationAddonSecret}`;

    console.log('Direct wrapper command: ' + wrapperCommand);

    const wrapperQuery = wrapperCommand
      ? `&wrapperCommand=${encodeURIComponent(wrapperCommand)}`
      : '';
    const launchUrl = `${baseUrl}&launchGameId=${gameId}${wrapperQuery}`;

    await mainWindow.loadURL(launchUrl);

    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
      onMainAppReady();
    });
  }
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

/* Sync IPC used by renderer during load; must be registered before any window loads */
ipcMain.on('is-dev', (event) => {
  event.returnValue = isDev();
});
ipcMain.on('get-version', (event) => {
  event.returnValue = VERSION;
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
let clientReadyListenerRegistered = false;

const IPC_READY_TIMEOUT_MS = 15000;

export async function sendIPCMessage(channel: string, ...args: any[]) {
  // If no renderer window is available (e.g., --game-id launch path), skip IPC dispatch
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (!isReadyForEvents) {
    let resolverRef: (() => void) | null = null;
    await Promise.race([
      new Promise<void>((resolve) => {
        console.log('waiting for events');
        resolverRef = resolve;
        readyForEventWaiters.push(resolve);
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (resolverRef !== null) {
            const idx = readyForEventWaiters.indexOf(resolverRef);
            if (idx !== -1) readyForEventWaiters.splice(idx, 1);
          }
          console.warn(
            '[sendIPCMessage] client-ready-for-events not received within timeout, proceeding'
          );
          resolve();
        }, IPC_READY_TIMEOUT_MS);
      }),
    ]);
    if (isReadyForEvents) console.log('events ready');
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

function registerMainHandlers(win: BrowserWindow) {
  if (handlersRegistered) return;
  handlersRegistered = true;

  AppEventHandler(win);
  FSEventHandler();
  RealdDebridHandler(win);
  AllDebridHandler(win);
  TorrentHandler(win);
  DirectDownloadHandler(win);
  AddonRestHandler();
  AddonManagerHandler(win);
  OOBEHandler();
  registerUmuHandlers();
}

function registerClientReadyListener() {
  if (clientReadyListenerRegistered) return;
  clientReadyListenerRegistered = true;

  ipcMain.on('client-ready-for-events', async () => {
    isReadyForEvents = true;
    for (const waiter of readyForEventWaiters) {
      waiter();
    }
    readyForEventWaiters = [];
  });
}

async function ensureAddonServerRunning() {
  if (server.listening) return;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.warn(
          `[addon-server] Port ${port} is already in use, continuing startup`
        );
        resolve();
        return;
      }
      reject(error);
    };

    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      console.log(`Addon Server is running on http://localhost:${port}`);
      console.log(`Server is being executed by electron!`);
      resolve();
    });
  });
}

async function startAddonRuntime() {
  await ensureAddonServerRunning();
  sendNotification({
    message: 'Addons Starting...',
    id: Math.random().toString(36).substring(7),
    type: 'success',
  });
  await startAddons();
}

function onMainAppReady() {
  closeSplashWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Register process-wide listeners only once
  if (!listenersRegistered) {
    listenersRegistered = true;

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
function createWindow(options: { gameLaunchMode?: boolean } = {}) {
  const gameLaunchMode = options.gameLaunchMode === true;

  mainWindow = new BrowserWindow({
    width: gameLaunchMode ? 1280 : 1000,
    height: gameLaunchMode ? 720 : 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      devTools: ogiDebug() || isDev(),
      preload: join(app.getAppPath(), 'out/preload/index.mjs'),
    },
    title: 'OpenGameInstaller',
    fullscreen: gameLaunchMode,
    fullscreenable: gameLaunchMode,
    resizable: gameLaunchMode,
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
    if (gameLaunchMode && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setResizable(true);
      mainWindow.setFullScreen(true);
    }
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

function focusMainWindow(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
  return true;
}

async function runAddonLaunchEvent(
  gameId: number,
  launchType: 'pre' | 'post'
): Promise<{ success: boolean; error?: string }> {
  const libraryInfo = loadLibraryInfo(gameId);
  if (!libraryInfo) {
    return { success: false, error: 'Game not found in library' };
  }

  const response = await addonServer.handleRequest({
    method: 'launchApp',
    params: {
      libraryInfo,
      launchType,
    },
  });

  if (response.tag === 'error') {
    return { success: false, error: response.error };
  }

  return { success: true };
}

async function handleRemoteLaunchRequest(
  payload: LaunchForwardPayload
): Promise<{ success: boolean; error?: string }> {
  console.log(
    `[instance-bridge] Remote launch requested for game ${payload.gameId}`,
    payload
  );

  focusMainWindow();

  if (payload.noLaunch) {
    if (!payload.runPre && !payload.runPost) {
      return {
        success: false,
        error: 'No hook stage specified for no-launch request',
      };
    }

    if (payload.runPre) {
      const preResult = await runAddonLaunchEvent(payload.gameId, 'pre');
      if (!preResult.success) {
        return preResult;
      }
    }

    if (payload.runPost) {
      const postResult = await runAddonLaunchEvent(payload.gameId, 'post');
      if (!postResult.success) {
        return postResult;
      }
    }

    return { success: true };
  }

  if (payload.wrapperCommand && payload.wrapperCommand.trim().length > 0) {
    const preResult = await runAddonLaunchEvent(payload.gameId, 'pre');
    if (!preResult.success) {
      return preResult;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }

    const wrapperResult = await executeWrapperCommandForApp(
      payload.gameId,
      payload.wrapperCommand
    );

    focusMainWindow();

    if (!wrapperResult.success) {
      return {
        success: false,
        error: wrapperResult.error ?? 'Wrapped launch failed',
      };
    }

    const postResult = await runAddonLaunchEvent(payload.gameId, 'post');
    if (!postResult.success) {
      return postResult;
    }

    return { success: true };
  }

  const preResult = await runAddonLaunchEvent(payload.gameId, 'pre');
  if (!preResult.success) {
    return preResult;
  }

  return await launchGameFromLibrary(payload.gameId, mainWindow);
}

registerInstanceBridgeHandlers({
  onFocus: () => focusMainWindow(),
  onLaunch: (payload) => handleRemoteLaunchRequest(payload),
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  registerClientReadyListener();

  // Check if we're launching a specific game (--game-id flag from Steam)
  const gameIdToLaunch = parseGameIdArg();
  const hookArgs = parseLaunchHookArgs();
  const wrapperCommand = parseWrapperAfterSeparator();
  const launchForwardPayload =
    gameIdToLaunch !== null
      ? buildLaunchForwardPayload(gameIdToLaunch, hookArgs, wrapperCommand)
      : null;

  // Before creating any window or starting runtime, check if another OGI instance
  // is already serving the local port and forward launch/focus requests to it.
  const runningInstanceAvailable = await isRunningInstanceAvailable();
  if (runningInstanceAvailable) {
    console.log('[instance-bridge] Existing instance detected on local port');

    if (launchForwardPayload) {
      const forwarded = await forwardLaunchToRunningInstance(
        launchForwardPayload
      );
      if (forwarded) {
        console.log(
          '[instance-bridge] Forwarded launch request to existing instance. Exiting this instance.'
        );
        app.quit();
        return;
      }
      console.warn(
        '[instance-bridge] Failed to forward launch request to existing instance.'
      );
      await requestRunningInstanceFocus();
      app.quit();
      return;
    } else {
      const focused = await requestRunningInstanceFocus();
      if (!focused) {
        console.warn(
          '[instance-bridge] Existing instance found, but focus handoff failed.'
        );
      }
      app.quit();
      return;
    }
  }

  if (gameIdToLaunch !== null) {
    console.log(
      `[app] Steam shortcut launch detected for game ${gameIdToLaunch}`
    );

    if (wrapperCommand) {
      console.log(
        `[app] Wrapper launch detected for game ${gameIdToLaunch}: ${wrapperCommand}`
      );
      await launchGameById(gameIdToLaunch, wrapperCommand);
      return;
    }

    // Check if this is a hook-only launch (--no-launch with --pre or --post)
    if (hookArgs.noLaunch && (hookArgs.runPre || hookArgs.runPost)) {
      if (hookArgs.runPre && hookArgs.runPost) {
        console.log(
          `[app] Hook-only launch detected (pre+post), running both hooks for game ${gameIdToLaunch}`
        );
        await handleLaunchHooks(gameIdToLaunch, 'pre');
        await handleLaunchHooks(gameIdToLaunch, 'post');
      } else {
        const hookType = hookArgs.runPre ? 'pre' : 'post';
        console.log(
          `[app] Hook-only launch detected (${hookType}-launch), running hooks for game ${gameIdToLaunch}`
        );
        await handleLaunchHooks(gameIdToLaunch, hookType);
      }
      return;
    }

    await launchGameById(gameIdToLaunch);
    return;
  }

  // Single window: create it and show splash first so Steam Deck / Game Mode keeps focus
  createWindow();

  if (mainWindow) {
    registerMainHandlers(mainWindow);
    await startAddonRuntime();
    await startAppFlow(mainWindow);
  }
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

    // stop all of the addons
    for (const process of Object.keys(processes)) {
      console.log(`Killing process ${process}`);
      processes[process].kill('SIGKILL');
    }

    // stopping all of the torrent intervals
    for (const interval of torrentIntervals) {
      clearInterval(interval);
    }

    // stop the server (only if it was listening to avoid hang)
    if (server.listening) {
      console.log('Stopping server...');
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
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
