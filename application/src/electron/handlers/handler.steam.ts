import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  FileSystemError,
  formatError,
  ipcBoundary,
  SteamRunningError,
} from '@ogi/errors';
import { Effect, Layer } from 'effect';
import { type BrowserWindow, dialog } from 'electron';
import {
  ensureLibraryDir,
  loadLibraryInfo,
} from '@/electron/handlers/helpers.app/library.js';
import { generateNotificationId } from '@/electron/handlers/helpers.app/notifications.js';
import {
  getCurrentUsername,
  getHomeDir,
  getOgiExecutablePath,
  getProtonPrefixPath,
  isLinux,
} from '@/electron/handlers/helpers.app/platform.js';
import {
  type SteamMutationOptions,
  type SteamMutationResult,
  SteamService,
  type SteamServiceError,
  SteamServiceLive,
  type SteamShortcutLookup,
} from '@/electron/handlers/helpers.app/steam.js';
import { SteamRepositoryLive } from '@/electron/lib/steam-installation.js';
import {
  getSteamCommandCandidates,
  type SteamInstallationKind,
  SteamProcessLive,
} from '@/electron/lib/steam-process.js';
import { getNonSteamLaunchId } from '@/electron/lib/steam-shortcuts.js';
import { sendNotification } from '@/electron/main.js';
import { ipcProcedure, router } from '@/electron/rpc/router-core.js';

export type SteamOperationResult =
  | SteamMutationResult
  | { status: 'cancelled'; message: string };

const SteamLive = SteamServiceLive.pipe(
  Layer.provide(Layer.merge(SteamRepositoryLive(), SteamProcessLive))
);

const provideSteam = <A, E>(effect: Effect.Effect<A, E, SteamService>) =>
  effect.pipe(Effect.provide(SteamLive));

export const getSteamShortcutForGame = (
  appID: number,
  oldSteamAppId?: number
): Effect.Effect<SteamShortcutLookup, SteamServiceError> =>
  provideSteam(
    Effect.gen(function* () {
      return yield* (yield* SteamService).lookup(appID, oldSteamAppId);
    })
  );

export const getSteamAppIdForGame = (appID: number, oldSteamAppId?: number) =>
  getSteamShortcutForGame(appID, oldSteamAppId).pipe(
    Effect.map((shortcut) => shortcut.appId)
  );

export const findSteamShortcutForGame = (
  appID: number,
  oldSteamAppId?: number
) =>
  getSteamShortcutForGame(appID, oldSteamAppId).pipe(
    Effect.catchTags({
      SteamNotFoundError: () => Effect.succeed(undefined),
      SteamUserNotFoundError: () => Effect.succeed(undefined),
      SteamShortcutNotFoundError: () => Effect.succeed(undefined),
    })
  );

export const findSteamAppIdForGame = (appID: number, oldSteamAppId?: number) =>
  findSteamShortcutForGame(appID, oldSteamAppId).pipe(
    Effect.map((shortcut) => shortcut?.appId)
  );

const confirmSteamClose = (
  mainWindow: BrowserWindow,
  operation: 'add' | 'remove'
): Effect.Effect<boolean, FileSystemError> =>
  Effect.tryPromise({
    try: async () => {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Steam must close briefly',
        message: `Steam is running and must close before OpenGameInstaller can ${operation} this shortcut safely.`,
        detail:
          'OpenGameInstaller will wait for Steam to exit, update shortcuts.vdf, and restart Steam automatically.',
        buttons: ['Cancel', 'Close Steam and Continue'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
    catch: (cause) =>
      new FileSystemError({
        message: 'Could not display the Steam shutdown confirmation',
        cause,
      }),
  });

export const runSteamMutationWithConfirmation = (
  mainWindow: BrowserWindow,
  operation: 'add' | 'remove',
  options: SteamMutationOptions
): Effect.Effect<SteamOperationResult, SteamServiceError | FileSystemError> =>
  Effect.gen(function* () {
    const service = yield* SteamService;
    const initial = yield* Effect.either(service[operation](options));
    if (initial._tag === 'Right') return initial.right;
    if (!(initial.left instanceof SteamRunningError)) {
      return yield* Effect.fail(initial.left);
    }
    const confirmed = yield* confirmSteamClose(mainWindow, operation);
    if (!confirmed) {
      return {
        status: 'cancelled' as const,
        message: 'Steam shortcut update cancelled; no files were changed.',
      };
    }
    return yield* service[operation]({
      ...options,
      allowSteamShutdown: true,
    });
  }).pipe(provideSteam);

export function addUmuGameToSteam(
  mainWindow: BrowserWindow,
  params: { appID: number; oldSteamAppId?: number }
): Effect.Effect<SteamOperationResult, SteamServiceError | FileSystemError> {
  return runSteamMutationWithConfirmation(mainWindow, 'add', params);
}

export function addDeckGameToSteam(
  mainWindow: BrowserWindow,
  appID: number
): Effect.Effect<void, SteamServiceError | FileSystemError> {
  if (!isLinux() || getCurrentUsername()?.toLowerCase() !== 'deck') {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const result = yield* addUmuGameToSteam(mainWindow, { appID });
    if (result.status === 'cancelled') {
      sendNotification({
        message:
          'Steam shortcut setup was cancelled. Add the game to Steam later from its configuration page.',
        id: generateNotificationId(),
        type: 'info',
      });
    } else if (result.warning) {
      sendNotification({
        message: result.warning,
        id: generateNotificationId(),
        type: 'warning',
      });
    }
  });
}

const launchViaSteam = (
  appId: number,
  installation: SteamInstallationKind
): Effect.Effect<{ status: 'success'; shortcutId: number }, FileSystemError> =>
  Effect.async((resume) => {
    const launchId = getNonSteamLaunchId(appId);
    const url = `steam://rungameid/${launchId}`;
    const [candidate] = getSteamCommandCandidates([url], installation);
    const child = execFile(
      candidate.command,
      candidate.args,
      { timeout: 15_000 },
      (cause) => {
        if (cause) {
          resume(
            Effect.fail(
              new FileSystemError({
                message: `Failed to launch the ${installation} Steam shortcut`,
                cause,
              })
            )
          );
        } else {
          resume(Effect.succeed({ status: 'success', shortcutId: appId }));
        }
      }
    );
    return Effect.sync(() => child.kill());
  });

export function createSteamShortcutDesktop(params: {
  appID: number;
  name: string;
  version?: string;
}): Effect.Effect<{ status: 'success' }, FileSystemError> {
  if (!isLinux()) {
    return Effect.fail(
      new FileSystemError({ message: 'Only available on Linux' })
    );
  }
  const homeDir = getHomeDir();
  if (!homeDir) {
    return Effect.fail(
      new FileSystemError({ message: 'Home directory not found' })
    );
  }
  const sanitizedGameName = params.name
    .replace(new RegExp('[\\r\\n\\x00-\\x1F=]', 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const ogiPath = getOgiExecutablePath();
  const desktopEntry = `[Desktop Entry]
Name=${sanitizedGameName}
Exec="${ogiPath}" --game-id=${params.appID}
Type=Application
Categories=Game;
Icon=steam_icon_${params.appID}
`;
  return Effect.try({
    try: () => {
      const desktopDir = join(homeDir, '.local', 'share', 'applications');
      fs.mkdirSync(desktopDir, { recursive: true });
      const desktopFile = join(desktopDir, `ogi-${params.appID}.desktop`);
      fs.writeFileSync(desktopFile, desktopEntry);
      fs.chmodSync(desktopFile, '755');
      return { status: 'success' as const };
    },
    catch: (cause) =>
      new FileSystemError({
        message: 'Could not create the Steam desktop shortcut',
        cause,
      }),
  });
}

export function registerSteamHandlers(mainWindow: BrowserWindow) {
  const getSteamAppId = ipcProcedure(
    'app.getSteamAppId',
    ipcBoundary((_, appID: number) =>
      getSteamAppIdForGame(appID).pipe(
        Effect.map((appId) => ({ status: 'success' as const, appId }))
      )
    )
  );

  const launchSteamApp = ipcProcedure(
    'app.launchSteamApp',
    ipcBoundary((_, appID: number) =>
      Effect.gen(function* () {
        if (!isLinux()) {
          return yield* Effect.fail(
            new FileSystemError({ message: 'Only available on Linux' })
          );
        }
        let appInfo = loadLibraryInfo(appID);
        if (!appInfo) {
          return yield* Effect.fail(
            new FileSystemError({ message: 'Game not found' })
          );
        }
        const existingSteamShortcut = yield* findSteamShortcutForGame(appID);
        const existingSteamAppId = existingSteamShortcut?.appId;
        let migrated = false;
        if (
          !appInfo.umu &&
          appInfo.launchExecutable.toLowerCase().endsWith('.exe')
        ) {
          const { migrateToUmu } = yield* Effect.promise(
            () => import('@/electron/handlers/handler.umu.js')
          );
          const migration = yield* Effect.tryPromise({
            try: () => migrateToUmu(appID, existingSteamAppId),
            catch: (cause) =>
              new FileSystemError({
                message: `Migration failed: ${formatError(cause)}`,
                cause,
              }),
          });
          if (!migration.success) {
            return yield* Effect.fail(
              new FileSystemError({
                message: migration.error ?? 'Migration failed',
              })
            );
          }
          appInfo = loadLibraryInfo(appID);
          if (!appInfo) {
            return yield* Effect.fail(
              new FileSystemError({
                message: 'Game disappeared during migration',
              })
            );
          }
          migrated = true;
        }

        const shouldUpsertShortcut =
          existingSteamAppId === undefined ||
          migrated ||
          (appInfo.umu !== undefined &&
            appInfo.umu.steamShortcutId === undefined);
        if (shouldUpsertShortcut) {
          const added = yield* runSteamMutationWithConfirmation(
            mainWindow,
            'add',
            {
              appID,
              oldSteamAppId: existingSteamAppId,
            }
          );
          if (added.status === 'cancelled') return added;
          if (added.steamAppId === undefined) {
            return yield* Effect.fail(
              new FileSystemError({
                message:
                  'Steam did not return a shortcut ID after adding the game',
              })
            );
          }
          return yield* launchViaSteam(added.steamAppId, added.installation);
        }
        if (existingSteamShortcut !== undefined) {
          return yield* launchViaSteam(
            existingSteamShortcut.appId,
            existingSteamShortcut.installation
          );
        }
        return yield* Effect.fail(
          new FileSystemError({ message: 'Steam shortcut was not found' })
        );
      })
    )
  );

  const checkPrefixExists = ipcProcedure(
    'app.checkPrefixExists',
    ipcBoundary((_, appID: number) =>
      Effect.gen(function* () {
        const appInfo = loadLibraryInfo(appID);
        if (!appInfo) return { exists: false, error: 'Game not found' };
        if (appInfo.umu?.winePrefixPath) {
          return {
            exists: fs.existsSync(appInfo.umu.winePrefixPath),
            prefixPath: appInfo.umu.winePrefixPath,
          };
        }
        const lookup = yield* Effect.either(getSteamAppIdForGame(appID));
        if (lookup._tag === 'Left') {
          return { exists: false, error: lookup.left.message };
        }
        const prefixPath = getProtonPrefixPath(lookup.right);
        return { exists: fs.existsSync(prefixPath), prefixPath };
      })
    )
  );

  const addToSteam = ipcProcedure(
    'app.addToSteam',
    ipcBoundary((_, appID: number, oldSteamAppId: number | undefined) =>
      Effect.gen(function* () {
        if (!isLinux()) {
          return yield* Effect.fail(
            new FileSystemError({ message: 'Only available on Linux' })
          );
        }
        ensureLibraryDir();
        let appInfo = loadLibraryInfo(appID);
        if (!appInfo) {
          return yield* Effect.fail(
            new FileSystemError({ message: 'Game not found' })
          );
        }
        if (
          !appInfo.umu &&
          appInfo.launchExecutable.toLowerCase().endsWith('.exe')
        ) {
          const detected = yield* findSteamAppIdForGame(appID);
          const { migrateToUmu } = yield* Effect.promise(
            () => import('@/electron/handlers/handler.umu.js')
          );
          const migration = yield* Effect.tryPromise({
            try: () => migrateToUmu(appID, oldSteamAppId ?? detected),
            catch: (cause) =>
              new FileSystemError({
                message: `Migration failed: ${formatError(cause)}`,
                cause,
              }),
          });
          if (!migration.success) {
            return yield* Effect.fail(
              new FileSystemError({
                message: migration.error ?? 'Migration failed',
              })
            );
          }
          appInfo = loadLibraryInfo(appID);
          if (!appInfo) {
            return yield* Effect.fail(
              new FileSystemError({
                message: 'Game disappeared during migration',
              })
            );
          }
        }
        return yield* runSteamMutationWithConfirmation(mainWindow, 'add', {
          appID,
          oldSteamAppId,
        });
      })
    )
  );

  const removeFromSteam = ipcProcedure(
    'app.removeFromSteam',
    ipcBoundary((_, appID: number) => {
      if (!isLinux()) {
        return Effect.fail(
          new FileSystemError({ message: 'Only available on Linux' })
        );
      }
      return runSteamMutationWithConfirmation(mainWindow, 'remove', { appID });
    })
  );

  return router(
    getSteamAppId,
    launchSteamApp,
    checkPrefixExists,
    addToSteam,
    removeFromSteam
  );
}
