import * as path from 'node:path';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { SikarugirError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { SikarugirRuntime } from '@/electron/lib/sikarugir/index.js';
import type { SikarugirRuntimeError } from '@/electron/lib/sikarugir/runtime.js';
import { saveLibraryInfo } from './library.js';

const persist = (
  updated: LibraryInfo
): Effect.Effect<LibraryInfo, SikarugirError> =>
  Effect.try({
    try: () => {
      saveLibraryInfo(updated.appID, updated);
      return updated;
    },
    catch: (cause) =>
      new SikarugirError({
        message: 'Could not persist the game library metadata',
        step: 'library-metadata',
        cause,
      }),
  });

/**
 * Record the Wine-visible paths for a direct-launch game. No Steam shortcut is
 * created, so this works before (or entirely without) a Windows Steam login.
 */
export const recordSikarugirGameMetadata = (
  data: LibraryInfo
): Effect.Effect<LibraryInfo, SikarugirRuntimeError, SikarugirRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* SikarugirRuntime;
    const windowsExecutable = yield* runtime.toWindowsPath(
      path.resolve(data.cwd, data.launchExecutable)
    );
    const windowsWorkingDirectory = yield* runtime.toWindowsPath(
      path.resolve(data.cwd)
    );
    return yield* persist({
      ...data,
      sikarugir: {
        ...data.sikarugir,
        launchMethod: data.sikarugir?.launchMethod ?? 'direct',
        windowsExecutable,
        windowsWorkingDirectory,
      },
    });
  });

export const upsertSikarugirShortcut = (
  data: LibraryInfo
): Effect.Effect<LibraryInfo, SikarugirRuntimeError, SikarugirRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* SikarugirRuntime;
    const executablePath = path.resolve(data.cwd, data.launchExecutable);
    const workingDirectory = path.resolve(data.cwd);
    const windowsExecutable = yield* runtime.toWindowsPath(executablePath);
    const windowsWorkingDirectory =
      yield* runtime.toWindowsPath(workingDirectory);
    yield* runtime.upsertShortcut({
      gameId: data.appID,
      appName: data.name,
      executablePath,
      workingDirectory,
    });
    const updated: LibraryInfo = {
      ...data,
      sikarugir: {
        // Preserved so a game pinned to the Steam hand-off is not silently
        // switched back to direct launch by a shortcut refresh.
        launchMethod: data.sikarugir?.launchMethod,
        // Only ever set after real-Mac validation; the shortcut appId
        // is NOT a usable launch id (Valve steam-for-linux#9463).
        steamLaunchId: data.sikarugir?.steamLaunchId,
        windowsExecutable,
        windowsWorkingDirectory,
      },
    };
    return yield* persist(updated);
  });
