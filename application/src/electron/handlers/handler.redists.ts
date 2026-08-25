import type { LibraryInfo } from '@ogi-sdk/connect';
import { formatError, LibraryError, PlatformError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { type BrowserWindow } from 'electron';
import {
  addDeckGameToSteam,
  findSteamAppIdForGame,
} from '@/electron/handlers/handler.steam.js';
import {
  installRedistributablesWithUmu,
  migrateToUmu,
  type RedistributableInstallProgress,
} from '@/electron/handlers/handler.umu.js';
import {
  loadLibraryInfo,
  saveLibraryInfo,
} from '@/electron/handlers/helpers.app/library.js';
import { isLinux } from '@/electron/handlers/helpers.app/platform.js';
import { upsertSikarugirShortcut } from '@/electron/handlers/helpers.app/sikarugir.js';
import {
  SikarugirRuntime,
  SikarugirRuntimeLive,
} from '@/electron/lib/sikarugir/index.js';
import { sendIPCMessage } from '@/electron/main.js';
import { ipcProcedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary } from '@/electron/runtime.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

type RedistributableLibraryInfo = LibraryInfo & {
  redistributables?: { name: string; path: string }[];
};

const installRedistributablesWithSikarugir = (
  appInfo: RedistributableLibraryInfo,
  emitProgress: (progress: RedistributableInstallProgress) => void
): Effect.Effect<'success' | 'failed', never> =>
  Effect.gen(function* () {
    const runtime = yield* SikarugirRuntime;
    const redistributables = appInfo.redistributables ?? [];
    const total = redistributables.length;
    let completedCount = 0;
    let failedCount = 0;

    for (const [index, redistributable] of redistributables.entries()) {
      const progress = (): number =>
        total === 0 ? 100 : ((completedCount + failedCount) / total) * 100;
      emitProgress({
        kind: 'item',
        total,
        completedCount,
        failedCount,
        overallProgress: progress(),
        redistributableName: redistributable.name,
        redistributablePath: redistributable.path,
        index,
        status: 'installing',
      });

      if (redistributable.path !== 'winetricks') {
        failedCount++;
        emitProgress({
          kind: 'item',
          total,
          completedCount,
          failedCount,
          overallProgress: progress(),
          redistributableName: redistributable.name,
          redistributablePath: redistributable.path,
          index,
          status: 'failed',
          error: 'Only Winetricks redistributables are supported on macOS',
        });
        continue;
      }

      const result = yield* Effect.either(
        runtime.reconcileWinetricks([[redistributable.name]])
      );
      if (result._tag === 'Right' && result.right.missing.length === 0) {
        completedCount++;
        emitProgress({
          kind: 'item',
          total,
          completedCount,
          failedCount,
          overallProgress: progress(),
          redistributableName: redistributable.name,
          redistributablePath: redistributable.path,
          index,
          status: 'completed',
        });
        continue;
      }

      failedCount++;
      emitProgress({
        kind: 'item',
        total,
        completedCount,
        failedCount,
        overallProgress: progress(),
        redistributableName: redistributable.name,
        redistributablePath: redistributable.path,
        index,
        status: 'failed',
        error:
          result._tag === 'Left'
            ? formatError(result.left)
            : `Winetricks verb ${redistributable.name} remains missing`,
      });
    }

    let result: 'success' | 'failed' = failedCount === 0 ? 'success' : 'failed';
    let finalError: string | undefined;
    if (result === 'success') {
      const updatedInfo = loadLibraryInfo(appInfo.appID);
      if (updatedInfo) {
        // Insert the shortcut before clearing redistributables so a failure
        // here leaves the prerequisite list intact for the next retry.
        const shortcutResult = yield* Effect.either(
          upsertSikarugirShortcut(updatedInfo)
        );
        if (shortcutResult._tag === 'Left') {
          result = 'failed';
          finalError = `Could not insert the Windows Steam shortcut: ${formatError(shortcutResult.left)}`;
        } else {
          const withShortcut = shortcutResult.right;
          const saveResult = yield* Effect.either(
            Effect.try(() => {
              delete withShortcut.redistributables;
              saveLibraryInfo(appInfo.appID, withShortcut);
            })
          );
          if (saveResult._tag === 'Left') {
            result = 'failed';
            finalError = `Could not persist the game library metadata: ${formatError(saveResult.left)}`;
          }
        }
      } else {
        result = 'failed';
        finalError = 'The game disappeared before its Steam shortcut was added';
      }
    }
    emitProgress({
      kind: 'done',
      total,
      completedCount,
      failedCount,
      overallProgress: 100,
      result,
      error: finalError,
    });
    return result;
  }).pipe(Effect.provide(SikarugirRuntimeLive));

const installRedistributables = (
  mainWindow: BrowserWindow,
  appID: number,
  downloadId?: string
) =>
  Effect.gen(function* () {
    const emitProgress = (progress: RedistributableInstallProgress): void => {
      sendIPCMessage('app:redistributable-progress', {
        appID,
        downloadId,
        ...progress,
      });
    };
    if (!isLinux() && process.platform !== 'darwin') {
      emitProgress({
        kind: 'done',
        total: 0,
        completedCount: 0,
        failedCount: 0,
        overallProgress: 100,
        result: 'failed',
        error:
          'Redistributable installation is only supported on Linux and macOS',
      });
      return yield* Effect.fail(
        new PlatformError({
          message:
            'Redistributable installation is only supported on Linux and macOS',
          platform: process.platform,
        })
      );
    }
    const appInfo = loadLibraryInfo(appID) as RedistributableLibraryInfo | null;
    if (!appInfo) {
      emitProgress({
        kind: 'done',
        total: 0,
        completedCount: 0,
        failedCount: 0,
        overallProgress: 100,
        result: 'not-found',
        error: `Game not found for appID ${appID}`,
      });
      return yield* Effect.fail(
        new LibraryError({ message: 'Game not found', gameId: appID })
      );
    }
    if (process.platform === 'darwin') {
      return yield* installRedistributablesWithSikarugir(appInfo, emitProgress);
    }
    if (!appInfo.umu) {
      const steamAppId = yield* findSteamAppIdForGame(appID).pipe(
        Effect.mapError((cause) => {
          emitProgress({
            kind: 'done',
            total: appInfo.redistributables?.length ?? 0,
            completedCount: 0,
            failedCount: appInfo.redistributables?.length ?? 0,
            overallProgress: 100,
            result: 'failed',
            error: 'Failed to inspect the Steam shortcut',
          });
          return new LibraryError({
            message: formatError(cause),
            gameId: appID,
          });
        })
      );
      const migration = yield* Effect.tryPromise({
        try: () => migrateToUmu(appID, steamAppId),
        catch: (cause) =>
          new LibraryError({ message: formatError(cause), gameId: appID }),
      });
      if (!migration.success) {
        const error =
          migration.error ?? 'Failed to migrate legacy prefix to UMU';
        emitProgress({
          kind: 'done',
          total: appInfo.redistributables?.length ?? 0,
          completedCount: 0,
          failedCount: appInfo.redistributables?.length ?? 0,
          overallProgress: 100,
          result: 'failed',
          error,
        });
        return yield* Effect.fail(
          new LibraryError({ message: error, gameId: appID })
        );
      }
    }

    const result = yield* Effect.tryPromise({
      try: () => installRedistributablesWithUmu(appID, emitProgress),
      catch: (cause) =>
        new LibraryError({ message: formatError(cause), gameId: appID }),
    });

    yield* Effect.forkDaemon(addDeckGameToSteam(mainWindow, appID));

    // Redistributable failures are non-fatal: each failure already emitted
    // progress + a warning notification, and the game itself is installed.
    if (result === 'not-found') {
      return yield* Effect.fail(
        new LibraryError({ message: 'Game not found', gameId: appID })
      );
    }
    return result;
  });

export function registerRedistributableHandlers(mainWindow: BrowserWindow) {
  return router(
    ipcProcedure(
      ElectronRpc.app.installRedistributables,
      (_, appID: number, downloadId?: string) =>
        runEffectBoundary(
          installRedistributables(mainWindow, appID, downloadId).pipe(
            Effect.catchTags({
              PlatformError: () => Effect.succeed('failed' as const),
              LibraryError: (error) =>
                Effect.succeed(
                  error.message === 'Game not found'
                    ? ('not-found' as const)
                    : ('failed' as const)
                ),
            })
          )
        )
    )
  );
}
