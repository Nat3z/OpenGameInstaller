import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { ipcProcedure, router } from '@/electron/rpc/router-core.js';

/**
 * Library CRUD IPC handlers
 * Updated to support UMU (Unified Launcher for Windows Games on Linux)
 */

import type { LibraryInfo } from '@ogi-sdk/connect';
import {
  FileSystemError,
  formatError,
  ipcBoundary,
  LibraryError,
} from '@ogi-sdk/errors';
import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
  spawnSync,
} from 'child_process';
import { Effect } from 'effect';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import { parse as shellQuoteParse } from 'shell-quote';
import {
  addDeckGameToSteam,
  addUmuGameToSteam,
  findSteamAppIdForGame,
  runSteamMutationWithConfirmation,
} from '@/electron/handlers/handler.steam.js';
import {
  buildDllOverrides,
  getEffectiveDllOverrides,
  getEffectiveLaunchEnv,
  getLibraryUmuWinePrefix,
  getUmuWinePrefix,
  installUmu,
  isUmuInstalled,
  launchWithUmu,
  migrateToUmu,
  parseLaunchArgumentsAfterCommand,
  resolveLaunchCommand,
} from '@/electron/handlers/handler.umu.js';
import {
  addToInternalsApps,
  ensureInternalsDir,
  ensureLibraryDir,
  getAllLibraryFiles,
  loadLibraryInfo,
  saveLibraryInfo,
  stageLibraryRemoval,
} from '@/electron/handlers/helpers.app/library.js';
import { generateNotificationId } from '@/electron/handlers/helpers.app/notifications.js';
import { isLinux } from '@/electron/handlers/helpers.app/platform.js';
import {
  recordSikarugirGameMetadata,
  upsertSikarugirShortcut,
} from '@/electron/handlers/helpers.app/sikarugir.js';
import {
  appMetadataSubtrees,
  type DeleteGuardRoots,
  filesystemRoot,
  isProtectedDeletePath,
  sharesDirectoryWithOtherGames,
  systemSubtrees,
} from '@/electron/lib/delete-guards.js';
import {
  effectiveLaunchMethod,
  SikarugirRuntime,
  SikarugirRuntimeLive,
} from '@/electron/lib/sikarugir/index.js';
import { resolveSpawnInvocation } from '@/electron/lib/spawn-shell.js';
import { sendNotification } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { runElectronEffect } from '@/electron/runtime.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/** Library appIDs with a game process currently launched by OGI. */
const runningGames = new Set<number>();

/** Per-game serial queues so launches and removals cannot interleave mid-flight. */
const gameOperationQueues = new Map<number, Promise<unknown>>();

function enqueueGameOperation<T>(
  appID: number,
  operation: () => Promise<T>
): Promise<T> {
  const previous = gameOperationQueues.get(appID) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  gameOperationQueues.set(appID, settled);
  void settled.then(() => {
    if (gameOperationQueues.get(appID) === settled) {
      gameOperationQueues.delete(appID);
    }
  });
  return result;
}

const deleteGuardRoots = (): DeleteGuardRoots => ({
  exact: [filesystemRoot(), homedir(), __dirname],
  subtrees: [...appMetadataSubtrees(__dirname), ...systemSubtrees()],
});

/**
 * Determine if a game should use UMU mode
 * - If game has `umu` config → use UMU
 */
function shouldUseUmuMode(libraryInfo: LibraryInfo): Effect.Effect<boolean> {
  return Effect.sync(() => isLinux() && Boolean(libraryInfo.umu));
}

export type LaunchGameResult = {
  success: boolean;
  error?: string;
};

export type ExecuteWrapperResult = {
  success: boolean;
  exitCode?: number;
  signal?: string;
  error?: string;
};

type DirectLaunchSignal =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Run a Windows game through the Sikarugir wrapper launcher. The launcher
 * process represents the game itself, so `game:launch` is emitted when it
 * spawns and `game:exit` when it closes - the same shape the UMU branch uses.
 */
function launchSikarugirGameDirectly(
  appInfo: LibraryInfo,
  mainWindow?: Electron.BrowserWindow | null
): Effect.Effect<LaunchGameResult, LibraryError> {
  return Effect.gen(function* () {
    const appID = appInfo.appID;
    const executablePath = path.resolve(appInfo.cwd, appInfo.launchExecutable);
    const workingDirectory = path.resolve(appInfo.cwd);
    // Everything after %command% is a game flag; without %command% the whole
    // argument string is, matching the wrapper-command branch.
    const afterCommand = parseLaunchArgumentsAfterCommand(
      appInfo.launchArguments
    );
    const flags =
      afterCommand.length > 0
        ? afterCommand
        : resolveLaunchCommand(
            appInfo.launchExecutable,
            appInfo.launchArguments
          ).args;

    const signal = yield* Effect.tryPromise({
      try: () =>
        // Register inside the queue so a concurrent removal cannot interleave.
        enqueueGameOperation(appID, async () => {
          runningGames.add(appID);
          let reportSpawn: () => void = () => undefined;
          let reportFailure: (error: string) => void = () => undefined;
          const spawnSignal = new Promise<DirectLaunchSignal>((resolve) => {
            reportSpawn = () => resolve({ ok: true });
            reportFailure = (error) => resolve({ ok: false, error });
          });
          // The session outlives this promise: launchGame only completes when
          // the launcher process exits, which is the game's exit.
          void runElectronEffect(
            Effect.either(
              Effect.gen(function* () {
                const runtime = yield* SikarugirRuntime;
                yield* runtime.launchGame({
                  executablePath,
                  workingDirectory,
                  flags,
                  onLaunch: () => reportSpawn(),
                });
              }).pipe(Effect.provide(SikarugirRuntimeLive))
            )
          ).then((result) => {
            if (result._tag === 'Left') {
              const message = formatError(result.left);
              logger.sync.error(`[launch] Sikarugir game failed: ${message}`);
              // No-op once the launcher already spawned.
              reportFailure(message);
            }
            runningGames.delete(appID);
            mainWindow?.webContents.send('game:exit', { id: appID });
          });
          return spawnSignal;
        }),
      catch: (cause) =>
        new LibraryError({
          message: `Failed to launch game with Sikarugir: ${String(cause)}`,
          gameId: appID,
        }),
    }).pipe(
      Effect.onError(() => Effect.sync(() => runningGames.delete(appID)))
    );

    if (!signal.ok) {
      sendNotification({
        message: `Failed to launch game: ${signal.error}`,
        id: generateNotificationId(),
        type: 'error',
      });
      return { success: false, error: signal.error };
    }
    mainWindow?.webContents.send('game:launch', { id: appID });
    return { success: true };
  });
}

export function launchGameFromLibrary(
  appid: number | string,
  mainWindow?: Electron.BrowserWindow | null,
  launchEnv?: Record<string, string>
): Effect.Effect<LaunchGameResult, LibraryError> {
  return Effect.gen(function* () {
    logger.sync.info('[launch] Launching game', appid);
    ensureLibraryDir();
    ensureInternalsDir();

    const parsedAppId =
      typeof appid === 'number' ? appid : parseInt(String(appid), 10);
    if (Number.isNaN(parsedAppId)) {
      return { success: false, error: 'Invalid app ID' };
    }

    const loadedAppInfo = loadLibraryInfo(parsedAppId);
    if (!loadedAppInfo) {
      logger.sync.info('[launch] Game not found');
      return { success: false, error: 'Game not found' };
    }
    let appInfo: LibraryInfo = loadedAppInfo;

    if (
      isLinux() &&
      !appInfo.umu &&
      appInfo.launchExecutable.toLowerCase().endsWith('.exe')
    ) {
      const oldSteamAppId = yield* findSteamAppIdForGame(parsedAppId).pipe(
        Effect.mapError(
          (cause) =>
            new LibraryError({
              message: `Failed to inspect Steam shortcut: ${cause.message}`,
              gameId: parsedAppId,
            })
        )
      );
      const migration = yield* Effect.tryPromise({
        try: () => migrateToUmu(parsedAppId, oldSteamAppId),
        catch: (cause) =>
          new LibraryError({
            message: `Failed to migrate legacy game to UMU: ${String(cause)}`,
            gameId: parsedAppId,
          }),
      });
      if (!migration.success) return migration;
      const migratedAppInfo = loadLibraryInfo(parsedAppId);
      if (!migratedAppInfo)
        return { success: false, error: 'Game disappeared during migration' };
      appInfo = migratedAppInfo;

      if (mainWindow && oldSteamAppId !== undefined) {
        const shortcutResult = yield* addUmuGameToSteam(mainWindow, {
          appID: parsedAppId,
          oldSteamAppId,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new LibraryError({
                message: `Failed to migrate Steam shortcut: ${cause.message}`,
                gameId: parsedAppId,
              })
          )
        );
        if (shortcutResult.status === 'cancelled') {
          logger.sync.warn(
            '[launch] Steam shortcut migration was cancelled; continuing with direct UMU launch'
          );
        }
      }
    }

    // Check if we should use UMU mode
    const useUmu = yield* shouldUseUmuMode(appInfo);

    if (useUmu) {
      logger.sync.info(`[launch] Using UMU mode for ${appInfo.name}`);

      const appID = appInfo.appID;
      // Register inside the queue so a concurrent removal cannot interleave;
      // onError cleans up if the launch promise itself rejects.
      const result = yield* Effect.tryPromise({
        try: () =>
          enqueueGameOperation(parsedAppId, async () => {
            runningGames.add(appInfo.appID);
            return launchWithUmu(appInfo, {
              onExit: () => {
                runningGames.delete(appID);
                mainWindow?.webContents.send('game:exit', { id: appID });
              },
            });
          }),
        catch: (cause) =>
          new LibraryError({
            message: `Failed to launch game with UMU: ${String(cause)}`,
            gameId: parsedAppId,
          }),
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => runningGames.delete(appInfo.appID))
        )
      );

      if (!result.success) {
        runningGames.delete(appInfo.appID);
        logger.sync.error('[launch] UMU launch failed:', result.error);
        sendNotification({
          message: `Failed to launch game: ${result.error}`,
          id: generateNotificationId(),
          type: 'error',
        });
        mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
        return {
          success: false,
          error: result.error ?? 'Failed to launch game with UMU',
        };
      }

      // Already tracked by the pre-await add above; do not re-add here or a
      // fast crash's onExit delete would be resurrected.
      mainWindow?.webContents.send('game:launch', { id: appInfo.appID });
      return { success: true };
    }

    if (
      process.platform === 'darwin' &&
      appInfo.launchExecutable.toLowerCase().endsWith('.exe')
    ) {
      logger.sync.info(`[launch] Using Sikarugir mode for ${appInfo.name}`);
      const launchMethod = effectiveLaunchMethod(appInfo.sikarugir);
      if (!appInfo.sikarugir) {
        const preparation = yield* Effect.either(
          Effect.gen(function* () {
            const runtime = yield* SikarugirRuntime;
            const setupState = yield* runtime.setupState;
            // Direct launch runs the game through the wrapper launcher, so it
            // only needs the wrapper and its prefix - not a Steam login.
            if (launchMethod === 'direct') {
              if (
                setupState.state === 'wrapper-missing' ||
                setupState.state === 'prefix-missing'
              ) {
                return {
                  ready: false as const,
                  error: 'Finish Windows-game support setup before playing.',
                };
              }
              return {
                ready: true as const,
                appInfo: yield* recordSikarugirGameMetadata(appInfo),
              };
            }
            if (
              setupState.state !== 'ready' ||
              setupState.steamAccountSelectionRequired
            ) {
              const needsSteamSignIn =
                setupState.state === 'steam-login-required' ||
                (setupState.state === 'ready' &&
                  setupState.steamAccountSelectionRequired);
              return {
                ready: false as const,
                error: needsSteamSignIn
                  ? 'Finish the Windows Steam sign-in and account selection before playing.'
                  : 'Finish Windows-game support setup before playing.',
              };
            }
            return {
              ready: true as const,
              appInfo: yield* upsertSikarugirShortcut(appInfo),
            };
          }).pipe(Effect.provide(SikarugirRuntimeLive))
        );
        if (preparation._tag === 'Left' || !preparation.right.ready) {
          const error =
            preparation._tag === 'Left'
              ? formatError(preparation.left)
              : (preparation.right.error ??
                'Finish Windows-game support setup before playing.');
          logger.sync.error(`[launch] Sikarugir preparation failed: ${error}`);
          sendNotification({
            message: error,
            id: generateNotificationId(),
            type: 'error',
          });
          return { success: false, error };
        }
        appInfo = preparation.right.appInfo;
      }
      const sikarugir = appInfo.sikarugir;
      if (!sikarugir) {
        return {
          success: false,
          error: 'Finish Windows-game support setup before playing.',
        };
      }

      if (launchMethod === 'direct') {
        return yield* launchSikarugirGameDirectly(appInfo, mainWindow);
      }

      const result = yield* Effect.either(
        Effect.gen(function* () {
          const runtime = yield* SikarugirRuntime;
          yield* runtime.launchSteam(sikarugir);
        }).pipe(Effect.provide(SikarugirRuntimeLive))
      );
      if (result._tag === 'Left') {
        logger.sync.error(
          `[launch] Sikarugir launch failed: ${result.left.message}`
        );
        sendNotification({
          message: `Failed to launch game: ${result.left.message}`,
          id: generateNotificationId(),
          type: 'error',
        });
        return { success: false, error: result.left.message };
      }

      mainWindow?.webContents.send('game:launch', { id: appInfo.appID });
      if (!sikarugir.steamLaunchId) {
        sendNotification({
          message: `Windows Steam opened. Select ${appInfo.name} inside Steam to play.`,
          id: generateNotificationId(),
          type: 'info',
        });
      }
      // The wrapper cannot observe the game's exit, so this is a hand-off:
      // resolve the launch immediately instead of pinning the UI on PLAYING.
      mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
      return { success: true };
    }

    // Legacy mode
    const effectiveLaunchEnv = getEffectiveLaunchEnv(appInfo);
    const {
      command: launchExecutable,
      args: otherLaunchArguments,
      tokens: launchTokens,
    } = resolveLaunchCommand(appInfo.launchExecutable, appInfo.launchArguments);
    logger.sync.info(
      'Launching game:',
      launchExecutable,
      otherLaunchArguments,
      'in cwd:',
      appInfo.cwd
    );

    const spawnInvocation = resolveSpawnInvocation(
      launchExecutable,
      otherLaunchArguments,
      launchTokens
    );
    const spawnOptions: SpawnOptions = {
      cwd: appInfo.cwd,
      shell: spawnInvocation.shell,
      env: {
        ...process.env,
        ...(launchEnv ?? {}),
        ...effectiveLaunchEnv,
      },
    };
    // Register + spawn inside the queue so a concurrent removal cannot
    // interleave with the launch.
    const spawnedItem: ChildProcess = yield* Effect.tryPromise({
      try: () =>
        enqueueGameOperation(parsedAppId, async () => {
          runningGames.add(appInfo.appID);
          return spawnInvocation.args
            ? spawn(spawnInvocation.command, spawnInvocation.args, spawnOptions)
            : spawn(spawnInvocation.command, spawnOptions);
        }),
      catch: (cause) =>
        new LibraryError({
          message: `Failed to launch game: ${String(cause)}`,
          gameId: parsedAppId,
        }),
    });
    spawnedItem.on('error', (error) => {
      logger.sync.error(error);
      runningGames.delete(appInfo.appID);
      sendNotification({
        message: 'Failed to launch game',
        id: generateNotificationId(),
        type: 'error',
      });
      mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
    });
    spawnedItem.on('exit', (exitCode, signal) => {
      runningGames.delete(appInfo.appID);
      logger.sync.info(
        'Game exited with code: ' +
          exitCode +
          (signal ? ` signal: ${signal}` : '')
      );
      if (exitCode !== 0 && exitCode != null) {
        sendNotification({
          message: 'Game Crashed',
          id: generateNotificationId(),
          type: 'error',
        });
      }
      mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
    });

    mainWindow?.webContents.send('game:launch', { id: appInfo.appID });
    return { success: true };
  });
}

export function executeWrapperCommandForApp(
  appid: number,
  wrapperCommand: string,
  type: 'steam-proton' | 'unknown',
  launchEnv?: Record<string, string>
): Effect.Effect<ExecuteWrapperResult> {
  if (type === 'steam-proton') {
    return executeWrapperCommandForAppSteam(appid, wrapperCommand, launchEnv);
  }
  return Effect.succeed({
    success: false,
    error: 'Unsupported wrapper command type',
  });
}

function executeWrapperCommandForAppSteam(
  appid: number,
  wrapperCommand: string,
  launchEnv?: Record<string, string>
): Effect.Effect<ExecuteWrapperResult> {
  return Effect.gen(function* () {
    ensureLibraryDir();

    const appInfo = loadLibraryInfo(appid);
    if (!appInfo) {
      return { success: false, error: 'Game not found' };
    }

    if (!wrapperCommand || wrapperCommand.trim().length === 0) {
      return { success: false, error: 'Wrapper command is empty' };
    }

    /* Built for Proton Steam */

    logger.sync.info(
      `[wrapper] Executing wrapper command for ${appInfo.name}: ${wrapperCommand}`
    );

    // Parse so paths with spaces aren't broken: split on the known verb first,
    // parse only the prefix (which may contain quoted paths), and treat
    // everything after the verb as a single path argument we replace with
    // appInfo.launchExecutable.
    const verb = 'waitforexitandrun';
    const verbWithSpaces = ` ${verb} `;
    const steamArgSeparator = ' -- ';
    const verbIndexInString = wrapperCommand.indexOf(verbWithSpaces);
    let parsed: ReturnType<typeof shellQuoteParse>;
    if (verbIndexInString !== -1) {
      const prefix = wrapperCommand.slice(0, verbIndexInString).trimEnd();
      parsed = shellQuoteParse(prefix);
      parsed.push(verb);
      // Everything after " waitforexitandrun " is the exe path (may contain spaces);
      // we replace it with the canonical path, so we don't parse the suffix.
    } else {
      parsed = shellQuoteParse(wrapperCommand);

      const firstToken =
        parsed.length > 0 && typeof parsed[0] === 'string' ? parsed[0] : '';
      const looksLikeCollapsedLauncher =
        firstToken.includes('steam-launch-wrapper') &&
        firstToken.includes(steamArgSeparator);
      if (looksLikeCollapsedLauncher) {
        const lastSeparatorInString =
          wrapperCommand.lastIndexOf(steamArgSeparator);
        if (lastSeparatorInString !== -1) {
          const prefix = wrapperCommand
            .slice(0, lastSeparatorInString)
            .trimEnd();
          parsed = shellQuoteParse(prefix);
          parsed.push('--');
        }
      }
    }

    // Some Steam wrapper payloads arrive with a Proton executable path split
    // across tokens (for example: ".../common/Proton", "-", "Experimental/proton").
    // Recombine those segments so the wrapped launcher gets a valid executable path.
    const normalizeSplitProtonExecutable = (
      tokens: ReturnType<typeof shellQuoteParse>
    ): ReturnType<typeof shellQuoteParse> => {
      const normalized: ReturnType<typeof shellQuoteParse> = [];
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (typeof token !== 'string') {
          normalized.push(token);
          continue;
        }

        const isSplitProtonStart =
          token.includes('/steamapps/common/Proton') &&
          !token.includes('/proton') &&
          !token.endsWith('/proton');

        if (!isSplitProtonStart) {
          normalized.push(token);
          continue;
        }

        let merged = token;
        let j = i + 1;
        while (j < tokens.length) {
          const next = tokens[j];
          if (typeof next !== 'string' || next === '--' || next === verb) {
            break;
          }
          merged += ` ${next}`;
          j += 1;
          if (merged.includes('/proton') || merged.endsWith('/proton')) {
            break;
          }
        }

        normalized.push(merged);
        i = j - 1;
      }

      return normalized;
    };

    parsed = normalizeSplitProtonExecutable(parsed);

    if (parsed.length === 0) {
      return { success: false, error: 'Wrapper command could not be parsed' };
    }
    const verbIndex = parsed.findIndex((x) => x === verb);
    const fixedArgs =
      verbIndex === -1
        ? [...parsed, appInfo.launchExecutable]
        : [...parsed.slice(0, verbIndex + 1), appInfo.launchExecutable];
    const wrappedCommand = parsed[0].toString();
    // for launch arguments, get everything after the %command% to include. not just replacing
    const launchArguments = parseLaunchArgumentsAfterCommand(
      appInfo.launchArguments
    );

    // If %command% is missing and launchArguments is empty, fall back to normal parser
    // to preserve wrapper launch tokens like WINEPREFIX=/path --fullscreen
    const effectiveLaunchArguments =
      launchArguments.length === 0
        ? resolveLaunchCommand(
            appInfo.launchExecutable,
            appInfo.launchArguments
          ).args
        : launchArguments;

    const wrappedArgv = [
      ...fixedArgs.slice(1).map((x) => x.toString()),
      ...effectiveLaunchArguments,
    ];

    logger.sync.info(
      `[wrapper] Resolved exec for ${
        appInfo.name
      }: command=${wrappedCommand} args=${JSON.stringify(wrappedArgv)}`
    );

    return yield* Effect.async<ExecuteWrapperResult>((resume) => {
      const effectiveLaunchEnv = getEffectiveLaunchEnv(appInfo);
      const effectiveDllOverrides = getEffectiveDllOverrides(appInfo);
      const dllOverrideString = buildDllOverrides(effectiveDllOverrides);
      const baseEnv = {
        ...process.env,
        ...(launchEnv ?? {}),
        ...effectiveLaunchEnv,
        PROTON_LOG: '1',
      };
      const env = appInfo.umu
        ? {
            ...baseEnv,
            STEAM_COMPAT_DATA_PATH: getLibraryUmuWinePrefix(appInfo),
            WINEPREFIX: getLibraryUmuWinePrefix(appInfo),
            ...(dllOverrideString
              ? { WINEDLLOVERRIDES: dllOverrideString }
              : {}),
          }
        : baseEnv;

      const wrappedChild = spawn(wrappedCommand, wrappedArgv, {
        cwd: appInfo.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      runningGames.add(appid);

      wrappedChild.stdout?.on('data', (data) => {
        logger.sync.info(`[wrapper stdout] ${data}`);
      });

      wrappedChild.stderr?.on('data', (data) => {
        logger.sync.error(`[wrapper stderr] ${data}`);
      });

      wrappedChild.on('error', (error) => {
        logger.sync.error(
          '[wrapper] Failed to execute wrapper command:',
          error
        );
        runningGames.delete(appid);
        resume(Effect.succeed({ success: false, error: error.message }));
      });

      wrappedChild.on('close', (code, signal) => {
        runningGames.delete(appid);
        if (code === 0) {
          resume(Effect.succeed({ success: true, exitCode: 0 }));
          return;
        }

        const error = `Wrapped command exited with code ${code ?? 'null'}${
          signal ? ` (signal: ${signal})` : ''
        }`;
        logger.sync.error(`[wrapper] ${error}`);
        resume(
          Effect.succeed({
            success: false,
            error,
            exitCode: code ?? undefined,
            signal: signal ?? undefined,
          })
        );
      });
    });
  });
}

export function registerLibraryHandlers(mainWindow: Electron.BrowserWindow) {
  const launchGame = ipcProcedure(
    ElectronRpc.app.launchGame,
    ipcBoundary((_, appid: string) =>
      Effect.gen(function* () {
        const result = yield* launchGameFromLibrary(Number(appid), mainWindow);
        if (!result.success) {
          return yield* Effect.fail(
            new LibraryError({
              message: result.error ?? 'Failed to launch game',
            })
          );
        }
      })
    )
  );

  const executeWrapperCommand = ipcProcedure(
    ElectronRpc.app.executeWrapperCommand,
    ipcBoundary((_, appid: number, wrapperCommand: string) =>
      executeWrapperCommandForAppSteam(appid, wrapperCommand)
    )
  );

  const removeApp = ipcProcedure(
    ElectronRpc.app.removeApp,
    ipcBoundary((_, appid: number) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            ensureLibraryDir();
            ensureInternalsDir();
          },
          catch: (cause) =>
            new FileSystemError({
              message: 'Could not update the library filesystem',
              cause,
            }),
        });
        const appInfo = yield* Effect.sync(() => loadLibraryInfo(appid));
        if (!appInfo) return { status: 'success' as const };

        const usesSikarugirShortcut =
          process.platform === 'darwin' && Boolean(appInfo.sikarugir);
        let detectedSteamAppId = usesSikarugirShortcut
          ? undefined
          : (appInfo.umu?.steamShortcutId ?? appInfo.umu?.steamShortcutReaddId);
        let steamCleanupWarning: string | undefined;
        if (!usesSikarugirShortcut && detectedSteamAppId === undefined) {
          const lookup = yield* Effect.either(findSteamAppIdForGame(appid));
          if (lookup._tag === 'Right') {
            detectedSteamAppId = lookup.right;
          } else {
            steamCleanupWarning = `The game was removed from the library, but its Steam shortcut could not be inspected: ${lookup.left.message}`;
          }
        }
        return yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => stageLibraryRemoval(appid),
            catch: (cause) =>
              new FileSystemError({
                message: 'Could not stage the library removal',
                cause,
              }),
          }),
          (removal) =>
            Effect.gen(function* () {
              let warning = steamCleanupWarning;
              if (usesSikarugirShortcut) {
                const shortcutResult = yield* Effect.either(
                  Effect.gen(function* () {
                    const runtime = yield* SikarugirRuntime;
                    yield* runtime.removeShortcut({
                      gameId: appInfo.appID,
                      appName: appInfo.name,
                      executablePath: path.resolve(
                        appInfo.cwd,
                        appInfo.launchExecutable
                      ),
                      workingDirectory: path.resolve(appInfo.cwd),
                    });
                  }).pipe(Effect.provide(SikarugirRuntimeLive))
                );
                if (shortcutResult._tag === 'Left') {
                  warning = `The game was removed from the library, but its Windows Steam shortcut could not be removed: ${formatError(shortcutResult.left)}`;
                }
              } else if (detectedSteamAppId !== undefined) {
                const steamResult = yield* Effect.either(
                  runSteamMutationWithConfirmation(mainWindow, 'remove', {
                    appID: appid,
                    oldSteamAppId: detectedSteamAppId,
                    libraryInfo: appInfo,
                    persistMetadata: false,
                  })
                );
                if (steamResult._tag === 'Left') {
                  warning = `The game was removed from the library, but its Steam shortcut could not be removed: ${steamResult.left.message}`;
                } else if (steamResult.right.status === 'cancelled') {
                  yield* Effect.try({
                    try: removal.rollback,
                    catch: (cause) =>
                      new FileSystemError({
                        message: 'Could not restore the staged library removal',
                        cause,
                      }),
                  });
                  return steamResult.right;
                }
              }

              yield* Effect.sync(removal.commit);

              // Delete the game files from disk; a failed, skipped, or
              // refused deletion is a warning, not a failed removal (the
              // library entry is already gone).
              let fileWarning: string | undefined;
              let filesDeleted = false;
              if (appInfo.cwd) {
                if (runningGames.has(appid)) {
                  fileWarning =
                    'The game was removed from the library, but its files were not deleted because the game is currently running.';
                } else if (
                  isProtectedDeletePath(appInfo.cwd, deleteGuardRoots())
                ) {
                  fileWarning =
                    'The game was removed from the library, but its files were not deleted because the path is a protected directory.';
                } else if (
                  sharesDirectoryWithOtherGames(
                    appid,
                    appInfo.cwd,
                    getAllLibraryFiles()
                  )
                ) {
                  fileWarning =
                    'The game was removed from the library, but its files were not deleted because the directory contains other games.';
                } else if (fs.existsSync(appInfo.cwd)) {
                  const deletion = yield* Effect.either(
                    Effect.tryPromise({
                      try: () =>
                        // Serialize against other per-game operations so a
                        // launch cannot interleave with the recursive rm
                        enqueueGameOperation(appid, async () => {
                          if (runningGames.has(appid)) {
                            throw new Error('the game is currently running');
                          }
                          await fsp.rm(appInfo.cwd, {
                            recursive: true,
                            force: true,
                          });
                        }),
                      catch: (cause) =>
                        cause instanceof Error ? cause.message : String(cause),
                    })
                  );
                  if (deletion._tag === 'Left') {
                    fileWarning = `The game was removed from the library, but its files could not be deleted: ${deletion.left}`;
                  } else {
                    filesDeleted = true;
                  }
                }
              }

              return {
                status: 'success' as const,
                warning:
                  [warning, fileWarning].filter(Boolean).join(' ') || undefined,
                filesDeleted,
              };
            }),
          (removal) =>
            Effect.try({
              try: removal.rollback,
              catch: (cause) =>
                new FileSystemError({
                  message: 'Could not restore the staged library removal',
                  cause,
                }),
            }).pipe(
              Effect.catchAll((error) =>
                logger.error('[library] Could not roll back removal', error)
              )
            )
        );
      })
    )
  );

  const insertApp = ipcProcedure(
    ElectronRpc.app.insertApp,
    ipcBoundary(
      (
        _,
        data: LibraryInfo & {
          redistributables?: { name: string; path: string }[];
        }
      ) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => {
              ensureLibraryDir();
              ensureInternalsDir();
            },
            catch: (cause) =>
              new FileSystemError({
                message: 'Could not update the library filesystem',
                cause,
              }),
          });

          // Check if UMU is available and should be used (Linux only; macOS uses legacy)
          const umuAvailable = isLinux();

          if (
            umuAvailable &&
            !data.umu &&
            data.launchExecutable.toLowerCase().endsWith('.exe')
          ) {
            data.umu = { umuId: `umu:${data.appID}` };
            logger.sync.info(
              `[setup] Added native UMU configuration for Windows game ${data.appID}`
            );
          }

          if (umuAvailable && data.umu) {
            logger.sync.info('[setup] Using UMU mode for new game');

            // Ensure UMU is installed (if not, try to install)
            const umuInstalled = yield* Effect.tryPromise({
              try: isUmuInstalled,
              catch: (cause: unknown) =>
                new LibraryError({
                  message: `Failed to check UMU: ${String(cause)}`,
                  gameId: data.appID,
                }),
            });
            if (!umuInstalled) {
              sendNotification({
                message: 'Installing UMU...',
                id: generateNotificationId(),
                type: 'info',
              });
              const installResult = yield* Effect.tryPromise({
                try: installUmu,
                catch: (cause: unknown) =>
                  new LibraryError({
                    message: `Failed to install UMU: ${String(cause)}`,
                    gameId: data.appID,
                  }),
              });
              if (!installResult.success) {
                logger.sync.error(
                  '[setup] UMU auto-install failed:',
                  installResult.error
                );
                sendNotification({
                  message: 'Failed to install UMU',
                  id: generateNotificationId(),
                  type: 'error',
                });
                data.umu = undefined;
                saveLibraryInfo(data.appID, data);
                addToInternalsApps(data.appID);
                return 'setup-failed';
              }
            }

            // Set up UMU-specific paths only when UMU is still configured (install succeeded or was already present)
            if (data.umu) {
              const { umuId } = data.umu;
              const winePrefixPath = getUmuWinePrefix(umuId);
              data.umu.winePrefixPath = winePrefixPath;

              // Ensure prefix directory exists
              if (!fs.existsSync(winePrefixPath)) {
                fs.mkdirSync(winePrefixPath, { recursive: true });
              }

              // Save the library info with UMU config
              saveLibraryInfo(data.appID, data);
              addToInternalsApps(data.appID);

              if (data.redistributables && data.redistributables.length > 0) {
                logger.sync.info(
                  '[setup] Redistributables detected, need to install them for:',
                  data.name
                );
                return 'setup-prefix-required';
              }

              yield* Effect.forkDaemon(
                addDeckGameToSteam(mainWindow, data.appID)
              );
              return 'setup-success';
            }
          }

          if (
            process.platform === 'darwin' &&
            data.launchExecutable.toLowerCase().endsWith('.exe')
          ) {
            // Persist first so a runtime failure still leaves the game in
            // the library where setup can be retried.
            saveLibraryInfo(data.appID, data);
            addToInternalsApps(data.appID);
            const setupResult = yield* Effect.either(
              Effect.gen(function* () {
                const runtime = yield* SikarugirRuntime;
                const setupState = yield* runtime.setupState;

                if (setupState.state === 'steam-login-required') {
                  return 'setup-steam-login-required' as const;
                }
                if (setupState.state !== 'ready') {
                  return 'setup-windows-support-required' as const;
                }
                if (setupState.steamAccountSelectionRequired) {
                  return 'setup-windows-support-required' as const;
                }
                if (data.redistributables?.length) {
                  return 'setup-prefix-required' as const;
                }
                yield* upsertSikarugirShortcut(data);
                return 'setup-success' as const;
              }).pipe(Effect.provide(SikarugirRuntimeLive))
            );
            if (setupResult._tag === 'Left') {
              logger.sync.error(
                `[setup] Sikarugir setup failed: ${setupResult.left.message}`
              );
              return 'setup-failed';
            }
            return setupResult.right;
          }

          // Native applications do not need a Wine prefix.
          saveLibraryInfo(data.appID, data);
          addToInternalsApps(data.appID);

          if (process.platform === 'win32') {
            // if there are redistributables, we need to install them
            if (data.redistributables && data.redistributables.length > 0) {
              let redistributableFailed = false;
              for (const redistributable of data.redistributables) {
                const result = yield* Effect.either(
                  Effect.gen(function* () {
                    if (!fs.existsSync(redistributable.path)) {
                      return yield* Effect.fail(
                        new LibraryError({
                          message: `Redistributable path does not exist: ${redistributable.path}`,
                          gameId: data.appID,
                        })
                      );
                    }
                    const installResult = spawnSync(redistributable.path, [], {
                      stdio: 'inherit',
                      shell: false,
                    });
                    if (installResult.error || installResult.status !== 0) {
                      return yield* Effect.fail(
                        new LibraryError({
                          message:
                            installResult.error?.message ??
                            `Redistributable installer exited with status ${installResult.status ?? 'unknown'}`,
                          gameId: data.appID,
                        })
                      );
                    }
                    sendNotification({
                      message: `Installed ${redistributable.name} for ${data.name}`,
                      id: generateNotificationId(),
                      type: 'success',
                    });
                  })
                );
                if (result._tag === 'Left') {
                  redistributableFailed = true;
                  logger.sync.error(
                    `[redistributable] failed to install ${redistributable.name}: ${result.left.message}`
                  );
                }
              }
              if (redistributableFailed) {
                // A failed redistributable should not fail the whole setup;
                // the game is installed either way.
                sendNotification({
                  message: `Some redistributables failed to install for ${data.name}. The game was still added.`,
                  id: generateNotificationId(),
                  type: 'warning',
                });
              }
            }
          }

          return 'setup-success';
        })
    )
  );

  const getAllApps = ipcProcedure(
    ElectronRpc.app.getAllApps,
    ipcBoundary(() => Effect.succeed(getAllLibraryFiles()))
  );

  const updateAppVersion = ipcProcedure(
    ElectronRpc.app.updateAppVersion,
    ipcBoundary(
      (
        _,
        appID: number,
        version: string,
        cwd: string,
        launchExecutable: string,
        launchArguments?: string,
        addonSource?: string,
        umu?: LibraryInfo['umu'],
        launchEnv?: LibraryInfo['launchEnv']
      ) => {
        const data = {
          appID,
          version,
          cwd,
          launchExecutable,
          launchArguments,
          addonSource,
          umu,
          launchEnv,
        };
        return Effect.gen(function* () {
          const existing = yield* Effect.sync(() =>
            loadLibraryInfo(data.appID)
          );
          if (!existing) return 'app-not-found';
          // Captured before Object.assign mutates `existing` via `appData`.
          const previousExecutablePath = path.resolve(
            existing.cwd,
            existing.launchExecutable
          );
          const previousWorkingDirectory = path.resolve(existing.cwd);

          const requestedUmu =
            data.umu ??
            (isLinux() && data.launchExecutable.toLowerCase().endsWith('.exe')
              ? ({ umuId: `umu:${data.appID}` } as LibraryInfo['umu'])
              : undefined);
          const updates: Partial<LibraryInfo> = {
            version: data.version,
            cwd: data.cwd,
            launchExecutable: data.launchExecutable,
            ...(data.addonSource !== undefined
              ? { addonsource: data.addonSource }
              : {}),
            ...(data.launchEnv !== undefined
              ? { launchEnv: data.launchEnv }
              : {}),
            ...(data.launchArguments !== undefined
              ? { launchArguments: data.launchArguments }
              : {}),
            ...(requestedUmu
              ? {
                  umu: {
                    ...existing.umu,
                    ...requestedUmu,
                    winePrefixPath:
                      existing.umu?.winePrefixPath ??
                      getUmuWinePrefix(requestedUmu.umuId),
                  },
                }
              : {}),
          };
          let appData = existing;

          if (requestedUmu && !existing.umu) {
            logger.sync.info('[update] Migrating game from legacy to UMU mode');
            const oldSteamAppId = yield* findSteamAppIdForGame(data.appID);
            const migrationResult = yield* Effect.tryPromise({
              try: () => migrateToUmu(data.appID, oldSteamAppId, updates),
              catch: (cause: unknown) =>
                new LibraryError({
                  message: `Migration failed: ${String(cause)}`,
                  gameId: data.appID,
                }),
            });
            if (!migrationResult.success || !migrationResult.libraryInfo) {
              return yield* Effect.fail(
                new LibraryError({
                  message:
                    migrationResult.error ?? 'Failed to migrate game to UMU',
                  gameId: data.appID,
                })
              );
            }
            appData = migrationResult.libraryInfo;
          } else {
            Object.assign(appData, updates);
          }

          saveLibraryInfo(data.appID, appData);
          if (process.platform === 'darwin' && existing.sikarugir) {
            if (data.launchExecutable.toLowerCase().endsWith('.exe')) {
              const shortcutUpdate = yield* Effect.either(
                upsertSikarugirShortcut(appData).pipe(
                  Effect.provide(SikarugirRuntimeLive)
                )
              );
              if (shortcutUpdate._tag === 'Left') {
                const message = formatError(shortcutUpdate.left);
                logger.sync.error(
                  `[update] Could not update the Windows Steam shortcut: ${message}`
                );
                // Drop the stale shortcut metadata so the next Play re-inserts
                // it from the updated paths instead of launching the old ones.
                delete appData.sikarugir;
                saveLibraryInfo(data.appID, appData);
                return yield* Effect.fail(
                  new LibraryError({
                    message: `The game was updated, but its Windows Steam shortcut could not be updated: ${message}`,
                    gameId: data.appID,
                  })
                );
              }
            } else {
              // The update switched the game to a native executable: retire
              // the Windows Steam shortcut and its metadata.
              const shortcutRemoval = yield* Effect.either(
                Effect.gen(function* () {
                  const runtime = yield* SikarugirRuntime;
                  yield* runtime.removeShortcut({
                    gameId: existing.appID,
                    appName: existing.name,
                    executablePath: previousExecutablePath,
                    workingDirectory: previousWorkingDirectory,
                  });
                }).pipe(Effect.provide(SikarugirRuntimeLive))
              );
              if (shortcutRemoval._tag === 'Left') {
                // Keep the metadata so removeApp or a later update retries
                // the cleanup instead of orphaning the shortcut.
                const message = formatError(shortcutRemoval.left);
                logger.sync.warn(
                  `[update] Could not remove the Windows Steam shortcut: ${message}`
                );
                return yield* Effect.fail(
                  new LibraryError({
                    message: `The game was updated, but its Windows Steam shortcut could not be removed: ${message}`,
                    gameId: data.appID,
                  })
                );
              } else {
                delete appData.sikarugir;
                saveLibraryInfo(data.appID, appData);
              }
            }
          }
          return 'success';
        });
      }
    )
  );

  const getLibraryInfo = ipcProcedure(
    ElectronRpc.app.getLibraryInfo,
    ipcBoundary((_, appID: number) => Effect.succeed(loadLibraryInfo(appID)))
  );

  return router(
    launchGame,
    executeWrapperCommand,
    removeApp,
    insertApp,
    getAllApps,
    updateAppVersion,
    getLibraryInfo
  );
}
