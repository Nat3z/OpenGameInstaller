import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import '@/electron/lib/source-maps.js';
import type { ConfigurationFile } from '@ogi-sdk/connect';
import { Effect } from 'effect';
import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron';
import fs, { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { startAddons } from '@/electron/handlers/handler.addon.js';
import {
  awaitPendingFileDeletions,
  type ExecuteWrapperResult,
  executeWrapperCommandForApp,
  hasPendingFileDeletions,
  launchGameFromLibrary,
} from '@/electron/handlers/handler.library.js';
import { loadLibraryInfo } from '@/electron/handlers/helpers.app/library.js';
import {
  isGamescopeSession,
  tagWindowForGamescope,
} from '@/electron/lib/gamescope.js';
import { releasePowerSaveBlock } from '@/electron/lib/power-save.js';
import { RendererEventReadiness } from '@/electron/lib/renderer-event-readiness.js';
import {
  createSingleInstanceData,
  type LaunchForwardPayload,
  parseGameIdArg,
  parseLaunchHookArgs,
  parseLaunchRequestFromArgv,
  parseWrapperAfterSeparator,
} from '@/electron/lib/single-instance-launch.js';
import { Addon } from '@/electron/manager/manager.addon.js';
import { waitForAddonManifests } from '@/electron/manager/manager.addon-readiness.js';
import { __dirname, isDev } from '@/electron/manager/manager.paths.js';
import { stopClient } from '@/electron/manager/manager.webtorrent.js';
import { createElectronRouter } from '@/electron/rpc/router.js';
import { registerElectronRpcHandlers } from '@/electron/rpc/server.js';
import {
  disposeElectronRuntime,
  runElectronEffect,
} from '@/electron/runtime.js';
import { runLaunchAppHooks } from '@/electron/server/addon-lifecycle.js';
import {
  addonServer,
  isAddonServerListening,
  isSecurityCheckEnabled,
  port,
  startAddonServer,
  stopAddonServer,
} from '@/electron/server/addon-server.js';
import {
  checkForAddonUpdates,
  convertLibrary,
  IS_NIXOS,
  startupEnvironmentReady,
} from '@/electron/startup.js';
import {
  closeSplashWindow,
  runStartupTasks,
} from '@/electron/startup-runner.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

// import steamworks from 'steamworks.js';

/**
 * Handle launch hooks (pre/post) for games
 * This runs addon events without actually launching the game
 * Used for save backup/restore and other addon-managed tasks
 */
async function handleLaunchHooks(
  gameId: number,
  hookType: 'pre' | 'post'
): Promise<void> {
  logger.sync.info(
    `[launch-hooks] Running ${hookType}-launch hooks for game ${gameId}`
  );

  // Create main window to show the launch screen
  createWindow({ gameLaunchMode: true });

  if (mainWindow) {
    registerMainHandlers(mainWindow);
    const startupResult = await runElectronEffect(runStartupTasks(mainWindow));
    if (startupResult.shutdownPending) {
      shutdownForInstallerUpdate(mainWindow);
      return;
    }
    await startAddonRuntime();

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
  logger.sync.info(
    `[launch] Steam shortcut launch detected for game ${gameId}, loading into main UI`
  );

  // Single window: create main window and pass game ID via query param
  createWindow({ gameLaunchMode: true });

  if (mainWindow) {
    registerMainHandlers(mainWindow);
    // Run startup tasks first
    const startupResult = await runElectronEffect(runStartupTasks(mainWindow));
    if (startupResult.shutdownPending) {
      shutdownForInstallerUpdate(mainWindow);
      return;
    }
    await startAddonRuntime();

    // Load the main app with the game ID in the query params
    // The Svelte frontend will detect this and show the GameLaunchOverlay
    const baseUrl = isDev()
      ? `http://localhost:8080`
      : `file://${join(app.getAppPath(), 'out', 'renderer', 'index.html')}`;

    logger.sync.info('Direct wrapper command: ' + wrapperCommand);

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

// Embedded gamescope only shows XWayland windows it can classify, so pin
// Chromium to X11 there; must run before app 'ready' to take effect.
// (ozone-platform-hint was removed in Electron 40 — use ozone-platform.)
if (isGamescopeSession()) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

// check if NixOS using command -v nixos-rebuild
logger.sync.info('continuing launch...');
logger.sync.info('NIXOS: ' + IS_NIXOS);
if (IS_NIXOS) {
  logger.sync.info(
    'NixOS detected, but startup logic has been moved. If you have issues, please check startup.ts'
  );
}
logger.sync.info('Running in directory: ' + __dirname);

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

let clientReadyListenerRegistered = false;
const rendererEventReadiness = new RendererEventReadiness();

const IPC_READY_TIMEOUT_MS = 15000;

export async function sendIPCMessage(channel: string, ...args: any[]) {
  // If no renderer window is available (e.g., --game-id launch path), skip IPC dispatch
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (!rendererEventReadiness.isReady()) {
    logger.sync.info('waiting for events');
    await rendererEventReadiness.wait(IPC_READY_TIMEOUT_MS, () =>
      logger.sync.warn(
        '[sendIPCMessage] client-ready-for-events not received within timeout, proceeding'
      )
    );
    if (rendererEventReadiness.isReady()) logger.sync.info('events ready');
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
    logger.sync.error(
      'Main window is not ready yet. Cannot send ask for input.'
    );
    return;
  }
  if (!mainWindow.webContents) {
    logger.sync.error(
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

  registerElectronRpcHandlers(createElectronRouter(win));
}

function registerClientReadyListener() {
  if (clientReadyListenerRegistered) return;
  clientReadyListenerRegistered = true;

  ipcMain.on('client-ready-for-events', () => {
    rendererEventReadiness.markReady();
  });
}

async function ensureAddonServerRunning() {
  if (isAddonServerListening) return;

  try {
    await runElectronEffect(startAddonServer());
    logger.sync.info(`Addon Server is running on http://localhost:${port}`);
    logger.sync.info(`Server is being executed by electron!`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      logger.sync.warn(
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
  await runElectronEffect(startAddons());
}

async function onMainAppReady() {
  closeSplashWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Run addon update check first so addon:update-available is sent before all-addons-started.
  // That way the frontend receives updates in addonUpdates before the handler runs and can auto-update.
  if (mainWindow && !mainWindow.isDestroyed()) {
    await runElectronEffect(checkForAddonUpdates(mainWindow));
  }
  await sendIPCMessage('all-addons-started');
  await runElectronEffect(waitForAddonManifests());
  await sendIPCMessage('addon-manifests-ready');

  // Register process-wide listeners only once
  if (!listenersRegistered) {
    listenersRegistered = true;

    app.on('browser-window-focus', function () {
      globalShortcut.register('CommandOrControl+R', () => {
        logger.sync.info('CommandOrControl+R is pressed: Shortcut Disabled');
      });
      globalShortcut.register('F5', () => {
        logger.sync.info('F5 is pressed: Shortcut Disabled');
      });
    });

    app.on('browser-window-blur', function () {
      globalShortcut.unregister('CommandOrControl+R');
      globalShortcut.unregister('F5');
    });
  }

  logger.sync.info('showing window');
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
      logger.sync.error('Blocked navigation to malformed URL:', navigationUrl);
      return;
    }

    if (
      parsedUrl.origin !== 'http://localhost:8080' &&
      parsedUrl.protocol !== 'file:'
    ) {
      event.preventDefault();
      logger.sync.warn(`Blocked navigation to: ${navigationUrl}`);
    }
  });

  mainWindow.webContents.on(
    'did-start-navigation',
    (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) rendererEventReadiness.reset();
    }
  );

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
    // Game Mode won't display an untagged Chromium window; tag after show so
    // the X11 window exists.
    if (mainWindow) void tagWindowForGamescope(mainWindow);
  });
}

async function startAppFlow(win: BrowserWindow) {
  // Run startup tasks; splash updates go to the main window
  let shutdownPending = false;
  if (win && !win.isDestroyed()) {
    const startupResult = await runElectronEffect(runStartupTasks(win));
    shutdownPending = startupResult.shutdownPending;
  }

  if (shutdownPending) {
    shutdownForInstallerUpdate(win);
    return;
  }

  await startAddonRuntime();

  // Load the main app into the same window (replaces splash)
  if (win && !win.isDestroyed()) {
    if (isDev()) {
      win.loadURL('http://localhost:8080');
      logger.sync.info('Running in development');
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

function shutdownForInstallerUpdate(win: BrowserWindow): void {
  if (!win.isDestroyed()) {
    win.close();
    return;
  }
  app.quit();
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

  return runElectronEffect(runLaunchAppHooks(libraryInfo, launchType));
}

async function handleRemoteLaunchRequest(
  payload: LaunchForwardPayload
): Promise<{ success: boolean; error?: string }> {
  logger.sync.info(
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

    let wrapperResult: ExecuteWrapperResult;
    try {
      if (payload.wrapperCommand.includes('steam-launch-wrapper')) {
        wrapperResult = await runElectronEffect(
          executeWrapperCommandForApp(
            payload.gameId,
            payload.wrapperCommand,
            'steam-proton',
            payload.launchEnv
          )
        );
      } else {
        wrapperResult = await runElectronEffect(
          executeWrapperCommandForApp(
            payload.gameId,
            payload.wrapperCommand,
            'unknown',
            payload.launchEnv
          )
        );
      }
    } finally {
      focusMainWindow();
    }

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

  const launchResult = await runElectronEffect(
    launchGameFromLibrary(payload.gameId, mainWindow, payload.launchEnv)
  );

  if (!launchResult.success) {
    sendLaunchErrorToRenderer(payload.gameId);
  }

  return launchResult;
}

const gotTheLock = app.requestSingleInstanceLock(createSingleInstanceData());

if (!gotTheLock) {
  app.quit();
} else {
  app.on(
    'second-instance',
    (_event, commandLine, _workingDirectory, additionalData) => {
      logger.sync.info(
        '[single-instance] Second instance detected:',
        commandLine
      );

      const launchPayload = parseLaunchRequestFromArgv(
        commandLine,
        additionalData
      );
      if (launchPayload) {
        void handleRemoteLaunchRequest(launchPayload)
          .then((result) => {
            if (!result.success) {
              logger.sync.error(
                `[single-instance] Launch failed for game ${launchPayload.gameId}: ${result.error ?? 'Unknown error'}`
              );
            }
          })
          .catch((error: unknown) => {
            focusMainWindow();
            sendLaunchErrorToRenderer(launchPayload.gameId);
            logger.sync.error(
              `[single-instance] Launch failed for game ${launchPayload.gameId}:`,
              error
            );
          });
        return;
      }

      focusMainWindow();
    }
  );
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
    logger.sync.info(
      `[app] Steam shortcut launch detected for game ${gameIdToLaunch}`
    );

    if (wrapperCommand) {
      logger.sync.info(
        `[app] Wrapper launch detected for game ${gameIdToLaunch}: ${wrapperCommand}`
      );
      await launchGameById(gameIdToLaunch, wrapperCommand);
      return;
    }

    // Check if this is a hook-only launch (--no-launch with --pre or --post)
    if (hookArgs.noLaunch && (hookArgs.runPre || hookArgs.runPost)) {
      if (hookArgs.runPre && hookArgs.runPost) {
        logger.sync.info(
          `[app] Hook-only launch detected (pre+post), running both hooks for game ${gameIdToLaunch}`
        );
        await handleLaunchHooks(gameIdToLaunch, 'pre');
        await handleLaunchHooks(gameIdToLaunch, 'post');
      } else {
        const hookType = hookArgs.runPre ? 'pre' : 'post';
        logger.sync.info(
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
    await startAppFlow(mainWindow);
  }
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  if (!gotTheLock || process.platform === 'darwin') return;
  void runElectronEffect(
    Effect.gen(function* () {
      releasePowerSaveBlock();
      logger.sync.info('Stopping torrent client...');
      yield* stopClient();
      for (const instance of [...Addon.running.values()]) {
        logger.sync.info(`Stopping addon ${instance.config.path}`);
        yield* instance.stop().pipe(Effect.ignore);
      }
      for (const interval of torrentIntervals) clearInterval(interval);
      if (isAddonServerListening) yield* stopAddonServer();
    }).pipe(
      Effect.catchAll((error) => logger.error('Error during cleanup:', error))
    )
  ).finally(() => {
    void disposeElectronRuntime().finally(() => app.quit());
  });
});

// A lazy game removal may still be deleting files; finish it before exiting so
// no half-deleted directory is left behind with its library entry gone.
let quitAfterDeletions = false;
app.on('will-quit', (event) => {
  if (quitAfterDeletions || !hasPendingFileDeletions()) return;
  event.preventDefault();
  quitAfterDeletions = true;
  logger.sync.info('Waiting for pending game file deletions before quitting');
  void awaitPendingFileDeletions().finally(() => app.quit());
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
