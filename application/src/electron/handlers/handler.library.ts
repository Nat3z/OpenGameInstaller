import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { ipcProcedure, router } from '@/electron/rpc/router-core.js';

/**
 * Library CRUD IPC handlers
 * Updated to support UMU (Unified Launcher for Windows Games on Linux)
 */

import type { LibraryInfo } from '@ogi-sdk/connect';
import { FileSystemError, ipcBoundary, LibraryError } from '@ogi-sdk/errors';
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
import { basename, dirname, join } from 'path';
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
import {
  generateNotificationId,
  notifyError,
  notifySuccess,
} from '@/electron/handlers/helpers.app/notifications.js';
import { isLinux } from '@/electron/handlers/helpers.app/platform.js';
import {
  appMetadataSubtrees,
  type DeleteGuardRoots,
  filesystemRoot,
  isProtectedDeletePath,
  sharesDirectoryWithOtherGames,
  systemSubtrees,
} from '@/electron/lib/delete-guards.js';
import { resolveSpawnInvocation } from '@/electron/lib/spawn-shell.js';
import { sendIPCMessage, sendNotification } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { ElectronRpc, type GameRemovalProgress } from '@/lib/electron-rpc.js';

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
 * Background deletions keyed by task id. Snapshots outlive the renderer so a
 * reload can re-query them; `done` lets shutdown wait for in-flight work.
 */
const removalTasks = new Map<
  string,
  { snapshot: GameRemovalProgress; done: Promise<void> }
>();
// Task ids stay unique when a game is re-added and removed again while its
// earlier task is still displayed.
let removalSequence = 0;

function removalTaskSnapshots(): GameRemovalProgress[] {
  return [...removalTasks.values()].map((task) => task.snapshot);
}

/** Drops finished tasks the renderer has dismissed; running ones stay. */
function dismissRemovalTasks(ids: string[]): void {
  for (const id of ids) {
    if (removalTasks.get(id)?.snapshot.status !== 'running') {
      removalTasks.delete(id);
    }
  }
}

export function hasPendingFileDeletions(): boolean {
  return [...removalTasks.values()].some(
    (task) => task.snapshot.status === 'running'
  );
}

/** Resolves once every in-flight deletion has settled. */
export function awaitPendingFileDeletions(): Promise<void> {
  return Promise.all([...removalTasks.values()].map((task) => task.done)).then(
    () => undefined
  );
}

/**
 * Deletes a removed game's files in the background, streaming throttled
 * `game:removal-progress` events to the renderer and keeping the latest
 * snapshot in `removalTasks`. The removal itself has already been committed;
 * this only cleans up the files on disk.
 *
 * The directory is first renamed to a hidden sibling so a reinstall into the
 * original path can never collide with the deletion. If the rename fails
 * (Windows refuses it while any file inside is open), deletion proceeds in
 * place and skips files changed since the snapshot was taken.
 */
function startBackgroundFileDeletion(
  appid: number,
  cwd: string,
  gameName: string
): string {
  const taskId = `removal-${appid}-${++removalSequence}`;
  const base = { id: taskId, appID: appid, gameName };
  // The main process owns the terminal notification so it fires exactly once
  // even if the renderer reloads mid-deletion.
  const send = (payload: GameRemovalProgress) => {
    const task = removalTasks.get(taskId);
    if (task) task.snapshot = payload;
    void sendIPCMessage('game:removal-progress', payload);
    if (payload.status === 'completed') {
      notifySuccess(`${gameName} removed from library and files deleted`);
    } else if (payload.status === 'error') {
      notifyError(
        `${gameName} was removed from the library, but its files could not be deleted: ${payload.error}`
      );
    }
  };

  // Serialize against other per-game operations so a launch cannot
  // interleave with the deletion.
  const done = enqueueGameOperation(appid, async () => {
    let deleted = 0;
    let total = 0;
    try {
      if (runningGames.has(appid)) {
        throw new Error('the game is currently running');
      }
      const startedAt = Date.now();
      const aside = join(
        dirname(cwd),
        `.${basename(cwd)}.ogi-removing-${startedAt}`
      );
      const movedAside = await fsp.rename(cwd, aside).then(
        () => true,
        () => false
      );
      const root = movedAside ? aside : cwd;
      const entries = await fsp.readdir(root, {
        recursive: true,
        withFileTypes: true,
      });
      const files = entries.filter((entry) => !entry.isDirectory());
      // Deepest first so each directory is empty by the time it is removed.
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort((a, b) => b.length - a.length);
      total = files.length;
      send({ ...base, status: 'running', progress: 0, deleted, total });

      let lastEmit = Date.now();
      for (const file of files) {
        const path = join(file.parentPath, file.name);
        // In place, a file rewritten since the snapshot belongs to whoever
        // rewrote it (e.g. a reinstall); ctime cannot be backdated.
        if (!movedAside) {
          const changed = await fsp.stat(path).then(
            (stat) => stat.ctimeMs >= startedAt,
            () => true
          );
          if (changed) continue;
        }
        await fsp.rm(path, { force: true });
        deleted++;
        const now = Date.now();
        if (now - lastEmit >= 200) {
          lastEmit = now;
          send({
            ...base,
            status: 'running',
            progress: (deleted / total) * 100,
            deleted,
            total,
          });
        }
      }
      // Sweep only directories that are now empty; anything written since the
      // snapshot is left alone.
      for (const directory of [...directories, root]) {
        await fsp.rmdir(directory).catch(() => undefined);
      }
      send({ ...base, status: 'completed', progress: 100, deleted, total });
    } catch (cause) {
      logger.sync.error(
        `[library] Background file deletion failed for ${appid}:`,
        cause
      );
      send({
        ...base,
        status: 'error',
        progress: total === 0 ? 0 : (deleted / total) * 100,
        deleted,
        total,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });
  removalTasks.set(taskId, {
    snapshot: { ...base, status: 'running', progress: 0, deleted: 0, total: 0 },
    done,
  });
  return taskId;
}

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

    let appInfo = loadLibraryInfo(parsedAppId);
    if (!appInfo) {
      logger.sync.info('[launch] Game not found');
      return { success: false, error: 'Game not found' };
    }

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
      appInfo = loadLibraryInfo(parsedAppId);
      if (!appInfo)
        return { success: false, error: 'Game disappeared during migration' };

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

        let detectedSteamAppId =
          appInfo.umu?.steamShortcutId ?? appInfo.umu?.steamShortcutReaddId;
        let steamCleanupWarning: string | undefined;
        if (detectedSteamAppId === undefined) {
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
              if (detectedSteamAppId !== undefined) {
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

              // Kick off file deletion lazily in the background; a skipped or
              // refused deletion is a warning, not a failed removal (the
              // library entry is already gone). Deletion progress streams to
              // the renderer via `game:removal-progress`.
              let fileWarning: string | undefined;
              let deletionTaskId: string | undefined;
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
                  deletionTaskId = yield* Effect.sync(() =>
                    startBackgroundFileDeletion(
                      appid,
                      appInfo.cwd,
                      appInfo.name
                    )
                  );
                }
              }

              return {
                status: 'success' as const,
                warning:
                  [warning, fileWarning].filter(Boolean).join(' ') || undefined,
                deletionTaskId,
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

  const getRemovalTasks = ipcProcedure(
    ElectronRpc.app.getRemovalTasks,
    ipcBoundary(() => Effect.succeed(removalTaskSnapshots()))
  );

  const clearRemovalTasks = ipcProcedure(
    ElectronRpc.app.clearRemovalTasks,
    ipcBoundary((_, ids: string[]) =>
      Effect.sync(() => dismissRemovalTasks(ids))
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
    getRemovalTasks,
    clearRemovalTasks,
    insertApp,
    getAllApps,
    updateAppVersion,
    getLibraryInfo
  );
}
