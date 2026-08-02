import {
  formatError,
  LibraryError,
  PlatformError,
  runEffectBoundary,
} from '@ogi/errors';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { Effect } from 'effect';
import { ipcMain } from 'electron';
import { findSteamAppIdForGame } from '@/electron/handlers/handler.steam.js';
import {
  installRedistributablesWithUmu,
  migrateToUmu,
  type RedistributableInstallProgress,
} from '@/electron/handlers/handler.umu.js';
import { loadLibraryInfo } from '@/electron/handlers/helpers.app/library.js';
import { isLinux } from '@/electron/handlers/helpers.app/platform.js';
import { sendIPCMessage } from '@/electron/main.js';

const installRedistributables = (appID: number, downloadId?: string) =>
  Effect.gen(function* () {
    const emitProgress = (progress: RedistributableInstallProgress): void => {
      sendIPCMessage('app:redistributable-progress', {
        appID,
        downloadId,
        ...progress,
      });
    };
    if (!isLinux()) {
      emitProgress({
        kind: 'done',
        total: 0,
        completedCount: 0,
        failedCount: 0,
        overallProgress: 100,
        result: 'failed',
        error: 'Redistributable installation is only supported on Linux',
      });
      return yield* Effect.fail(
        new PlatformError({
          message: 'Redistributable installation is only supported on Linux',
          platform: process.platform,
        })
      );
    }
    const appInfo = loadLibraryInfo(appID) as
      | (LibraryInfo & { redistributables?: { name: string; path: string }[] })
      | null;
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
    if (appInfo.umu) {
      return yield* Effect.tryPromise({
        try: () => installRedistributablesWithUmu(appID, emitProgress),
        catch: (cause) =>
          new LibraryError({ message: formatError(cause), gameId: appID }),
      });
    }
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
      const error = migration.error ?? 'Failed to migrate legacy prefix to UMU';
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
    return yield* Effect.tryPromise({
      try: () => installRedistributablesWithUmu(appID, emitProgress),
      catch: (cause) =>
        new LibraryError({ message: formatError(cause), gameId: appID }),
    });
  });

export function registerRedistributableHandlers(): void {
  ipcMain.handle(
    'app:install-redistributables',
    (_, appID: number, downloadId?: string) =>
      runEffectBoundary(
        installRedistributables(appID, downloadId).pipe(
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
  );
}
