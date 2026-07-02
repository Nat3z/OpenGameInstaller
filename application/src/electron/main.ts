import '@/electron/lib/source-maps.js';
import { join } from 'path';
import { quote as shellQuote } from 'shell-quote';
import {
  port,
  isSecurityCheckEnabled,
  isAddonServerListening,
  startAddonServer,
  stopAddonServer,
  addonServer,
} from '@/electron/server/addon-server.js';
import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron';
import fs, { existsSync, readFileSync } from 'fs';
import { Addon } from '@/electron/manager/manager.addon.js';
import { stopClient } from '@/electron/manager/manager.webtorrent.js';
import type { ConfigurationFile } from '@ogi-sdk/connect';
import AppEventHandler from '@/electron/handlers/handler.app.js';
import FSEventHandler from '@/electron/handlers/handler.fs.js';
import RealdDebridHandler from '@/electron/handlers/handler.realdebrid.js';
import AllDebridHandler from '@/electron/handlers/handler.alldebrid.js';
import TorrentHandler from '@/electron/handlers/handler.torrent.js';
import DirectDownloadHandler from '@/electron/handlers/handler.ddl.js';
import { runLaunchAppHooks } from '@/electron/server/addon-lifecycle.js';
import { __dirname, isDev } from '@/electron/manager/manager.paths.js';
import {
  checkForAddonUpdates,
  convertLibrary,
  IS_NIXOS,
  startupEnvironmentReady,
  STEAMTINKERLAUNCH_PATH,
} from '@/electron/startup.js';
import AddonManagerHandler, {
  startAddons,
} from '@/electron/handlers/handler.addon.js';
import { waitForAddonsConfigured } from '@/electron/manager/manager.addon-readiness.js';
import OOBEHandler from '@/electron/handlers/handler.oobe.js';
import {
  runStartupTasks,
  closeSplashWindow,
} from '@/electron/startup-runner.js';
import { registerUmuHandlers } from '@/electron/handlers/handler.umu.js';
import { registerPowerSaveHandlers } from '@/electron/handlers/handler.power-save.js';
import {
  executeWrapperCommandForApp,
  launchGameFromLibrary,
  type ExecuteWrapperResult,
} from '@/electron/handlers/handler.library.js';
import { loadLibraryInfo } from '@/electron/handlers/helpers.app/library.js';
import { releasePowerSaveBlock } from '@/electron/lib/power-save.js';
// import steamworks from 'steamworks.js';

type LaunchForwardPayload = {
  gameId: number;
  noLaunch: boolean;
  runPre: boolean;
  runPost: boolean;
  wrapperCommand?: string | null;
  originalArgv?: string[];
  launchEnv?: Record<string, string>;
};

/**
 * Parse command line arguments for --game-id flag
 * This is used when launching from Steam shortcuts
 */
function parseGameIdArg(argv: readonly string[] = process.argv): number | null {
  const gameIdArg = argv.find((arg) => arg.startsWith('--game-id='));
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
function parseLaunchHookArgs(argv: readonly string[] = process.argv): {
  noLaunch: boolean;
  runPre: boolean;
  runPost: boolean;
} {
  return {
    noLaunch: argv.includes('--no-launch'),
    runPre: argv.includes('--pre'),
    runPost: argv.includes('--post'),
  };
}

/**
 * Parse wrapper command from args after a `--` separator.
 * Everything after `--` is treated as the wrapper command payload.
 * Each argument is shell-quoted so paths with spaces survive round-trip
 * when the string is later parsed in the library handler.
 */
function parseWrapperAfterSeparator(
  argv: readonly string[] = process.argv
): string | null {
  const separatorIndex = argv.indexOf('--');
  if (separatorIndex === -1 || separatorIndex >= argv.length - 1) {
    return null;
  }

  const args = argv.slice(separatorIndex + 1);
  return args.map((arg) => shellQuote([arg])).join(' ');
}

function buildLaunchForwardPayload(
  gameId: number,
  hookArgs: ReturnType<typeof parseLaunchHookArgs>,
  wrapperCommand: string | null,
  argv: readonly string[] = process.argv
): LaunchForwardPayload {
  const launchEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );

  return {
    gameId,
    noLaunch: hookArgs.noLaunch,
    runPre: hookArgs.runPre,
    runPost: hookArgs.runPost,
    wrapperCommand,
    originalArgv: [...argv].slice(1),
    launchEnv,
  };
}

function parseLaunchRequestFromArgv(
  argv: readonly string[]
): LaunchForwardPayload | null {
  const gameId = parseGameIdArg(argv);
  if (gameId === null) {
    return null;
  }

  return buildLaunchForwardPayload(
    gameId,
    parseLaunchHookArgs(argv),
    parseWrapperAfterSeparator(argv),
    argv
  );
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
    const startupResult = await runStartupTasks(mainWindow);
    if (startupResult.shutdownPending) {
      return;
    }

    // Load the main app with game ID and hook flags
    const baseUrl = isDev()
      ? `http://localhost:8080`
      : `file://${join(app.getAppPath(), 'out', 'renderer', 'index.html')}`;

    // Add flags to indicate this is a hook-only launch
    const launchUrl = `${baseUrl}?launchGameId=${gameId}&hookType=${hookType}&noLaunch=true`;

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
    const startupResult = await runStartupTasks(mainWindow);
    if (startupResult.shutdownPending) {
      return;
    }

    // Load the main app with the game ID in the query params
    // The Svelte frontend will detect this and show the GameLaunchOverlay
    const baseUrl = isDev()
      ? `http://localhost:8080`
      : `file://${join(app.getAppPath(), 'out', 'renderer', 'index.html')}`;

    console.log('Direct wrapper command: ' + wrapperCommand);

    const wrapperQuery = wrapperCommand
      ? `&wrapperCommand=${encodeURIComponent(wrapperCommand)}`
      : '';
    const launchUrl = `${baseUrl}?launchGameId=${gameId}${wrapperQuery}`;

    await mainWindow.loadURL(launchUrl);

    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
      onMainAppReady();
    });
  }
}

export const VERSION = app.getVersion();

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

export let screenInputCallbacks = new Map<string, (result: any) => void>();

export function sendAskForInput(
  id: string,
  config: ConfigurationFile,
  name: string,
  description: string,
  callback: (result: any) => void
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
  screenInputCallbacks.set(id, callback);
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
  AddonManagerHandler(win);
  OOBEHandler();
  registerUmuHandlers();
  registerPowerSaveHandlers();
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
  if (isAddonServerListening) return;

  try {
    await startAddonServer();
    console.log(`Addon Server is running on http://localhost:${port}`);
    console.log(`Server is being executed by electron!`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `[addon-server] Port ${port} is already in use, continuing startup`
      );
      return;
    }
    throw error;
  }
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

async function onMainAppReady() {
  closeSplashWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Run addon update check first so addon:update-available is sent before all-addons-started.
  // That way the frontend receives updates in addonUpdates before the handler runs and can auto-update.
  if (mainWindow && !mainWindow.isDestroyed()) {
    await checkForAddonUpdates(mainWindow);
  }
  await sendIPCMessage('all-addons-started');
  const configuredAddons = await waitForAddonsConfigured();
  for (const connection of configuredAddons) {
    await sendIPCMessage('addon-connected', connection.addonInfo!.id);
  }
  await sendIPCMessage('addon-runtime-ready');

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
    'file://' +
      join(app.getAppPath(), 'public', 'splash.html') +
      '?secret=' +
      addonServer.getSecret()
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
  let shutdownPending = false;
  if (win && !win.isDestroyed()) {
    const startupResult = await runStartupTasks(win);
    shutdownPending = startupResult.shutdownPending;
  }

  if (shutdownPending) {
    return;
  }

  // Load the main app into the same window (replaces splash)
  if (win && !win.isDestroyed()) {
    if (isDev()) {
      win.loadURL('http://localhost:8080');
      console.log('Running in development');
    } else {
      win.loadURL(
        'file://' +
          join(app.getAppPath(), 'out', 'renderer', 'index.html') +
          '?secret=' +
          addonServer.getSecret()
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

function sendLaunchRequestedToRenderer(gameId: number) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('game:launch-requested', { id: gameId });
}

function sendLaunchErrorToRenderer(gameId: number) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('game:launch-error', { id: gameId });
}

function sendGameExitToRenderer(gameId: number) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('game:exit', { id: gameId });
}

async function runAddonLaunchEvent(
  gameId: number,
  launchType: 'pre' | 'post'
): Promise<{ success: boolean; error?: string }> {
  const libraryInfo = loadLibraryInfo(gameId);
  if (!libraryInfo) {
    return { success: false, error: 'Game not found in library' };
  }

  return runLaunchAppHooks(libraryInfo, launchType);
}

async function handleRemoteLaunchRequest(
  payload: LaunchForwardPayload
): Promise<{ success: boolean; error?: string }> {
  console.log(
    `[single-instance] Remote launch requested for game ${payload.gameId}`,
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
    sendLaunchRequestedToRenderer(payload.gameId);

    const preResult = await runAddonLaunchEvent(payload.gameId, 'pre');
    if (!preResult.success) {
      sendLaunchErrorToRenderer(payload.gameId);
      return preResult;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }

    let wrapperResult: ExecuteWrapperResult | null = null;
    if (payload.wrapperCommand.includes('steam-launch-wrapper')) {
      wrapperResult = await executeWrapperCommandForApp(
        payload.gameId,
        payload.wrapperCommand,
        'steam-proton',
        payload.launchEnv
      );
    } else {
      wrapperResult = await executeWrapperCommandForApp(
        payload.gameId,
        payload.wrapperCommand,
        'unknown',
        payload.launchEnv
      );
    }

    focusMainWindow();

    if (!wrapperResult.success) {
      sendLaunchErrorToRenderer(payload.gameId);
      return {
        success: false,
        error: wrapperResult.error ?? 'Wrapped launch failed',
      };
    }

    const postResult = await runAddonLaunchEvent(payload.gameId, 'post');
    if (!postResult.success) {
      sendLaunchErrorToRenderer(payload.gameId);
      return postResult;
    }

    sendGameExitToRenderer(payload.gameId);
    return { success: true };
  }

  sendLaunchRequestedToRenderer(payload.gameId);

  const preResult = await runAddonLaunchEvent(payload.gameId, 'pre');
  if (!preResult.success) {
    sendLaunchErrorToRenderer(payload.gameId);
    return preResult;
  }

  const launchResult = await launchGameFromLibrary(
    payload.gameId,
    mainWindow,
    payload.launchEnv
  );

  if (!launchResult.success) {
    sendLaunchErrorToRenderer(payload.gameId);
  }

  return launchResult;
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    console.log('[single-instance] Second instance detected:', commandLine);

    const launchPayload = parseLaunchRequestFromArgv(commandLine);
    if (launchPayload) {
      void handleRemoteLaunchRequest(launchPayload);
      return;
    }

    focusMainWindow();
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  if (!gotTheLock) {
    return;
  }

  await startupEnvironmentReady;
  registerClientReadyListener();

  // Check if we're launching a specific game (--game-id flag from Steam)
  const gameIdToLaunch = parseGameIdArg();
  const hookArgs = parseLaunchHookArgs();
  const wrapperCommand = parseWrapperAfterSeparator();
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
  if (!gotTheLock) {
    return;
  }

  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform === 'darwin') {
    return;
  }

  // Perform cleanup before quitting
  try {
    releasePowerSaveBlock();

    // stop torrenting
    console.log('Stopping torrent client...');
    await stopClient();

    for (const instance of [...Addon.running.values()]) {
      console.log(`Stopping addon ${instance.config.path}`);
      instance.stop();
    }

    // stopping all of the torrent intervals
    for (const interval of torrentIntervals) {
      clearInterval(interval);
    }

    if (isAddonServerListening) {
      console.log('Stopping addon server...');
      await stopAddonServer();
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
  }

  // Now quit the application
  app.quit();
});

app.on('activate', async function () {
  if (!gotTheLock) {
    return;
  }

  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
    if (mainWindow) await startAppFlow(mainWindow);
  }
});
