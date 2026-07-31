import * as fs from 'node:fs';
import { dirname, extname, join } from 'node:path';
import {
  GameNotFound,
  SteamArtworkError,
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
  type SteamLocation,
  SteamRepository,
  type SteamRepositoryError,
  writeFileAtomic,
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
import { __dirname } from '@/electron/manager/manager.paths.js';

export function getVersionedGameName(
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

type SteamGridDbResponse<T> = { success: boolean; data: T };
type SteamGridDbGame = { id: number };
type SteamGridDbImage = { url: string };

const readSteamGridDbKey = (): string | undefined => {
  const configPath = join(__dirname, 'config/option/steamgriddb.json');
  if (!fs.existsSync(configPath)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    apiKey?: unknown;
  };
  return typeof parsed.apiKey === 'string' && parsed.apiKey.trim()
    ? parsed.apiKey.trim()
    : undefined;
};

const fetchSteamGridDb = async <T>(url: string, apiKey: string): Promise<T> => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`SteamGridDB request failed with ${response.status}`);
  }
  const body = (await response.json()) as SteamGridDbResponse<T>;
  if (!body.success) throw new Error('SteamGridDB request was unsuccessful');
  return body.data;
};

const downloadSteamGridArtwork = (
  appName: string,
  appId: number,
  userdataPath: string
): Effect.Effect<void, SteamArtworkError> =>
  Effect.tryPromise({
    try: async () => {
      const apiKey = readSteamGridDbKey();
      if (!apiKey) return;
      const games = await fetchSteamGridDb<SteamGridDbGame[]>(
        `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(appName)}`,
        apiKey
      );
      const game = games[0];
      if (!game) return;
      const requests = [
        { endpoint: `grids/game/${game.id}?dimensions=600x900`, suffix: 'p' },
        { endpoint: `grids/game/${game.id}?dimensions=920x430`, suffix: '' },
        { endpoint: `heroes/game/${game.id}`, suffix: '_hero' },
        { endpoint: `logos/game/${game.id}`, suffix: '_logo' },
        { endpoint: `icons/game/${game.id}`, suffix: '_icon' },
      ];
      const gridDirectory = join(userdataPath, 'config/grid');
      await Promise.all(
        requests.map(async ({ endpoint, suffix }) => {
          const images = await fetchSteamGridDb<SteamGridDbImage[]>(
            `https://www.steamgriddb.com/api/v2/${endpoint}`,
            apiKey
          );
          const artwork = images[0];
          if (!artwork) return;
          const response = await fetch(artwork.url, {
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) return;
          const contentLength = Number(response.headers.get('content-length'));
          if (
            Number.isFinite(contentLength) &&
            contentLength > 20 * 1024 * 1024
          ) {
            throw new Error('SteamGridDB artwork exceeds the 20 MiB limit');
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 20 * 1024 * 1024) {
            throw new Error('SteamGridDB artwork exceeds the 20 MiB limit');
          }
          const extension = extname(
            new URL(artwork.url).pathname
          ).toLowerCase();
          const safeExtension = ['.png', '.jpg', '.jpeg', '.webp'].includes(
            extension
          )
            ? extension
            : '.png';
          await Effect.runPromise(
            writeFileAtomic(
              join(gridDirectory, `${appId}${suffix}${safeExtension}`),
              bytes
            )
          );
        })
      );
    },
    catch: (cause) =>
      new SteamArtworkError({
        message: `Could not download artwork for ${appName}`,
        cause,
      }),
  });

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
          getVersionedGameName(appInfo.name, appInfo.version),
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
        const matches: Array<{ appId: number; location: SteamLocation }> = [];
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
            matches.push({ appId: shortcut.right.appId, location });
          }
        }

        if (matches.length > 1) {
          return yield* Effect.fail(
            new SteamShortcutConflictError({
              message: `Multiple Steam users contain a shortcut for game ${appID}`,
              gameId: appID,
            })
          );
        }
        if (matches.length === 1) return matches[0];
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
        const appName = getVersionedGameName(appInfo.name, appInfo.version);
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
        const committed = yield* runWithSteamLifecycle({
          allowSteamShutdown: options.allowSteamShutdown ?? false,
          status: steamProcess.status(installation),
          shutdownAndWait: steamProcess.shutdownAndWait(installation),
          startAndWait: steamProcess.startAndWait(installation),
          operation: mutation,
        });
        const artwork = yield* Effect.either(
          downloadSteamGridArtwork(
            appName,
            committed.value,
            location.user.userdataPath
          )
        );
        const artworkWarning =
          artwork._tag === 'Left' ? artwork.left.message : undefined;
        return {
          status: 'success' as const,
          steamAppId: committed.value,
          installation,
          warning:
            [committed.restartWarning, artworkWarning]
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
