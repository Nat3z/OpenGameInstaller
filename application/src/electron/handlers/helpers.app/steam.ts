import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  GameNotFound,
  SteamRunningError,
  SteamShortcutConflictError,
  SteamShortcutNotFoundError,
  SteamVdfParseError,
  SteamVdfWriteError,
} from '@ogi/errors';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { Context, Effect, Layer } from 'effect';
import {
  getLibraryPath,
  loadLibraryInfo,
  saveLibraryInfo,
} from '@/electron/handlers/helpers.app/library.js';
import { getOgiExecutablePath } from '@/electron/handlers/helpers.app/platform.js';
import {
  copySteamGridArtwork,
  downloadSteamGridArtwork,
} from '@/electron/lib/steam-grid-db.js';
import {
  type SteamLocation,
  SteamRepository,
  type SteamRepositoryError,
} from '@/electron/lib/steam-installation.js';
import {
  getSteamInstallationKind,
  runWithSteamLifecycle,
  type SteamInstallationKind,
  SteamProcess,
  type SteamProcessFailure,
} from '@/electron/lib/steam-process.js';
import {
  findOwnedShortcut,
  readShortcuts,
  removeOwnedShortcut,
  upsertShortcut,
} from '@/electron/lib/steam-shortcuts.js';
import { serializeBinaryVdf } from '@/electron/lib/steam-vdf.js';

export function getLegacyVersionedGameName(
  name: string,
  version?: string | null
): string {
  if (!version?.trim()) return name;
  return `${name} (${version})`;
}

export type SteamServiceError =
  | GameNotFound
  | SteamRepositoryError
  | SteamProcessFailure
  | SteamRunningError
  | SteamShortcutConflictError
  | SteamShortcutNotFoundError
  | SteamVdfParseError
  | SteamVdfWriteError;

export type SteamMutationResult = {
  status: 'success';
  steamAppId?: number;
  installation: SteamInstallationKind;
  warning?: string;
};

export type SteamShortcutLookup = {
  appId: number;
  installation: SteamInstallationKind;
};

export interface SteamMutationOptions {
  appID: number;
  oldSteamAppId?: number;
  allowSteamShutdown?: boolean;
  libraryInfo?: LibraryInfo;
  persistMetadata?: boolean;
}

// The service layer is provided at separate IPC runtime boundaries, so this
// module-level semaphore keeps Steam closed for one complete mutation at a time.
const steamMutationLock = Effect.unsafeMakeSemaphore(1);

const loadGame = (appID: number) =>
  Effect.try({
    try: () => {
      const appInfo = loadLibraryInfo(appID);
      if (!appInfo) throw new GameNotFound({ gameId: appID });
      return appInfo;
    },
    catch: (cause) =>
      cause instanceof GameNotFound
        ? cause
        : new SteamVdfParseError({
            message: `Could not read library metadata for game ${appID}`,
            path: getLibraryPath(appID),
            cause,
          }),
  });

const saveGame = (
  appID: number,
  appInfo: NonNullable<ReturnType<typeof loadLibraryInfo>>
) =>
  Effect.try({
    try: () => saveLibraryInfo(appID, appInfo),
    catch: (cause) =>
      new SteamVdfWriteError({
        message: `Could not save Steam shortcut metadata for game ${appID}`,
        path: getLibraryPath(appID),
        cause,
      }),
  });

export class SteamService extends Context.Tag('SteamService')<
  SteamService,
  {
    readonly lookup: (
      appID: number,
      oldSteamAppId?: number
    ) => Effect.Effect<SteamShortcutLookup, SteamServiceError>;
    readonly add: (
      options: SteamMutationOptions
    ) => Effect.Effect<SteamMutationResult, SteamServiceError>;
    readonly remove: (
      options: SteamMutationOptions
    ) => Effect.Effect<SteamMutationResult, SteamServiceError>;
  }
>() {}

export const SteamServiceLive: Layer.Layer<
  SteamService,
  never,
  SteamRepository | SteamProcess
> = Layer.effect(
  SteamService,
  Effect.gen(function* () {
    const repository = yield* SteamRepository;
    const steamProcess = yield* SteamProcess;

    const identityFor = (
      appID: number,
      appInfo: NonNullable<ReturnType<typeof loadLibraryInfo>>,
      oldSteamAppId?: number
    ) => {
      const ogiExecutable = getOgiExecutablePath();
      return {
        gameId: appID,
        knownAppId:
          oldSteamAppId ??
          appInfo.umu?.steamShortcutReaddId ??
          appInfo.umu?.steamShortcutId,
        executable: ogiExecutable,
        legacyExecutables: [
          appInfo.launchExecutable,
          appInfo.umu?.steamShortcutLegacyExecutable,
        ].filter((value): value is string => value !== undefined),
        legacyNames: [
          getLegacyVersionedGameName(appInfo.name, appInfo.version),
          appInfo.name,
          appInfo.umu?.steamShortcutLegacyName,
        ].filter((value): value is string => value !== undefined),
      };
    };

    const lookupShortcut = (
      appID: number,
      appInfo: NonNullable<ReturnType<typeof loadLibraryInfo>>,
      oldSteamAppId?: number
    ) =>
      Effect.gen(function* () {
        const locations = yield* repository.locateAll;
        const matches = new Map<
          string,
          { appId: number; location: SteamLocation }
        >();
        let inspectionFailure:
          | SteamShortcutConflictError
          | SteamVdfParseError
          | SteamVdfWriteError
          | undefined;

        for (const location of locations) {
          const document = yield* Effect.either(
            repository.readShortcuts(location)
          );
          if (document._tag === 'Left') {
            inspectionFailure ??= document.left;
            continue;
          }
          const shortcut = yield* Effect.either(
            Effect.try({
              try: () =>
                findOwnedShortcut(
                  readShortcuts(serializeBinaryVdf(document.right.root))
                    .shortcuts,
                  identityFor(appID, appInfo, oldSteamAppId)
                ),
              catch: (cause) =>
                cause instanceof SteamShortcutConflictError
                  ? cause
                  : new SteamVdfParseError({
                      message: 'Could not inspect Steam shortcuts',
                      path: document.right.shortcutsPath,
                      cause,
                    }),
            })
          );
          if (shortcut._tag === 'Left') {
            inspectionFailure ??= shortcut.left;
          } else if (shortcut.right) {
            const shortcutsPath = document.right.shortcutsPath;
            const canonicalPath = yield* Effect.try({
              try: () =>
                fs.existsSync(shortcutsPath)
                  ? fs.realpathSync.native(shortcutsPath)
                  : resolve(shortcutsPath),
              catch: (cause) =>
                new SteamVdfParseError({
                  message: `Could not resolve ${shortcutsPath}`,
                  path: shortcutsPath,
                  cause,
                }),
            });
            const existingMatch = matches.get(canonicalPath);
            if (existingMatch && existingMatch.appId !== shortcut.right.appId) {
              return yield* Effect.fail(
                new SteamShortcutConflictError({
                  message: `Steam shortcut data for game ${appID} is inconsistent`,
                  gameId: appID,
                })
              );
            }
            matches.set(canonicalPath, {
              appId: shortcut.right.appId,
              location,
            });
          }
        }

        if (matches.size > 1) {
          return yield* Effect.fail(
            new SteamShortcutConflictError({
              message: `Multiple Steam users contain a shortcut for game ${appID}`,
              gameId: appID,
            })
          );
        }
        if (matches.size === 1) return [...matches.values()][0];
        if (inspectionFailure) return yield* Effect.fail(inspectionFailure);
        return yield* Effect.fail(
          new SteamShortcutNotFoundError({
            message: `Could not find the Steam shortcut for ${appInfo.name}`,
            gameId: appID,
          })
        );
      });

    const lookup = (appID: number, oldSteamAppId?: number) =>
      Effect.gen(function* () {
        const appInfo = yield* loadGame(appID);
        const shortcut = yield* lookupShortcut(appID, appInfo, oldSteamAppId);
        return {
          appId: shortcut.appId,
          installation: getSteamInstallationKind(shortcut.location.root),
        };
      });

    const addUnlocked = (options: SteamMutationOptions) =>
      Effect.gen(function* () {
        const appInfo = yield* loadGame(options.appID);
        const existing = yield* Effect.either(
          lookupShortcut(options.appID, appInfo, options.oldSteamAppId)
        );
        const location =
          existing._tag === 'Right'
            ? existing.right.location
            : existing.left instanceof SteamShortcutNotFoundError
              ? yield* repository.locate
              : yield* Effect.fail(existing.left);
        const installation = getSteamInstallationKind(location.root);
        const appName = appInfo.name;
        const oldAppId =
          existing._tag === 'Right'
            ? existing.right.appId
            : (options.oldSteamAppId ??
              appInfo.umu?.steamShortcutReaddId ??
              appInfo.umu?.steamShortcutId);
        const mutation = repository.modifyShortcuts(
          location,
          ({ root, shortcutsPath, commit, rollback }) =>
            Effect.gen(function* () {
              const upserted = yield* Effect.try({
                try: () =>
                  upsertShortcut(root, {
                    ...identityFor(
                      options.appID,
                      appInfo,
                      options.oldSteamAppId
                    ),
                    appName,
                    startDir: dirname(getOgiExecutablePath()),
                    launchOptions: `--game-id=${options.appID} --no-sandbox`,
                    tags: ['OpenGameInstaller'],
                  }),
                catch: (cause) =>
                  cause instanceof SteamShortcutConflictError
                    ? cause
                    : new SteamVdfParseError({
                        message: 'Could not update the Steam shortcut document',
                        path: shortcutsPath,
                        cause,
                      }),
              });
              yield* commit();
              if (appInfo.umu) {
                appInfo.umu.steamShortcutId = upserted.appId;
                delete appInfo.umu.steamShortcutReaddId;
                delete appInfo.umu.steamShortcutLegacyExecutable;
                delete appInfo.umu.steamShortcutLegacyName;
                const saved = yield* Effect.either(
                  saveGame(options.appID, appInfo)
                );
                if (saved._tag === 'Left') {
                  yield* rollback;
                  return yield* Effect.fail(saved.left);
                }
              }
              return upserted.appId;
            })
        );
        const operation = Effect.gen(function* () {
          const appId = yield* mutation;
          const warnings: string[] = [];
          const copiedArtwork = yield* Effect.either(
            copySteamGridArtwork({
              oldAppId,
              newAppId: appId,
              userdataPath: location.user.userdataPath,
            })
          );
          if (copiedArtwork._tag === 'Left') {
            warnings.push(copiedArtwork.left.message);
          }
          const downloadedArtwork = yield* Effect.either(
            downloadSteamGridArtwork({
              appName,
              appId,
              userdataPath: location.user.userdataPath,
            })
          );
          if (downloadedArtwork._tag === 'Left') {
            warnings.push(downloadedArtwork.left.message);
          }
          return {
            appId,
            artworkWarning: warnings.join(' ') || undefined,
          };
        });
        const committed = yield* runWithSteamLifecycle({
          allowSteamShutdown: options.allowSteamShutdown ?? false,
          status: steamProcess.status(installation),
          shutdownAndWait: steamProcess.shutdownAndWait(installation),
          startAndWait: steamProcess.startAndWait(installation),
          operation,
        });
        return {
          status: 'success' as const,
          steamAppId: committed.value.appId,
          installation,
          warning:
            [committed.restartWarning, committed.value.artworkWarning]
              .filter(Boolean)
              .join(' ') || undefined,
        };
      });

    const removeUnlocked = (options: SteamMutationOptions) =>
      Effect.gen(function* () {
        const appInfo = options.libraryInfo ?? (yield* loadGame(options.appID));
        const existing = yield* Effect.either(
          lookupShortcut(options.appID, appInfo, options.oldSteamAppId)
        );
        const location =
          existing._tag === 'Right'
            ? existing.right.location
            : existing.left instanceof SteamShortcutNotFoundError
              ? yield* repository.locate
              : yield* Effect.fail(existing.left);
        const installation = getSteamInstallationKind(location.root);
        const mutation = repository.modifyShortcuts(
          location,
          ({ root, shortcutsPath, commit, rollback }) =>
            Effect.gen(function* () {
              const removed = yield* Effect.try({
                try: () =>
                  removeOwnedShortcut(
                    root,
                    identityFor(options.appID, appInfo, options.oldSteamAppId)
                  ),
                catch: (cause) =>
                  cause instanceof SteamShortcutConflictError
                    ? cause
                    : new SteamVdfParseError({
                        message:
                          'Could not inspect the Steam shortcut document',
                        path: shortcutsPath,
                        cause,
                      }),
              });
              if (removed.removed) yield* commit();
              if (
                appInfo.umu?.steamShortcutId !== undefined ||
                appInfo.umu?.steamShortcutReaddId !== undefined
              ) {
                delete appInfo.umu.steamShortcutId;
                delete appInfo.umu.steamShortcutReaddId;
                delete appInfo.umu.steamShortcutLegacyExecutable;
                delete appInfo.umu.steamShortcutLegacyName;
                if (options.persistMetadata !== false) {
                  const saved = yield* Effect.either(
                    saveGame(options.appID, appInfo)
                  );
                  if (saved._tag === 'Left') {
                    if (removed.removed) yield* rollback;
                    return yield* Effect.fail(saved.left);
                  }
                }
              } else if (!removed.removed) {
                return yield* Effect.fail(
                  new SteamShortcutNotFoundError({
                    message: `Could not find the Steam shortcut for ${appInfo.name}`,
                    gameId: options.appID,
                  })
                );
              }
              return removed.appId;
            })
        );
        const committed = yield* runWithSteamLifecycle({
          allowSteamShutdown: options.allowSteamShutdown ?? false,
          status: steamProcess.status(installation),
          shutdownAndWait: steamProcess.shutdownAndWait(installation),
          startAndWait: steamProcess.startAndWait(installation),
          operation: mutation,
        });
        return {
          status: 'success' as const,
          steamAppId: committed.value,
          installation,
          warning: committed.restartWarning,
        };
      });

    const add = (options: SteamMutationOptions) =>
      steamMutationLock.withPermits(1)(addUnlocked(options));
    const remove = (options: SteamMutationOptions) =>
      steamMutationLock.withPermits(1)(removeUnlocked(options));

    return { lookup, add, remove };
  })
);
