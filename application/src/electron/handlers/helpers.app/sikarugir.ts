import * as path from 'node:path';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { Effect } from 'effect';
import { SikarugirRuntime } from '@/electron/lib/sikarugir/index.js';
import type { SikarugirRuntimeError } from '@/electron/lib/sikarugir/runtime.js';
import { saveLibraryInfo } from './library.js';

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
        // Only ever set after real-Mac validation; the shortcut appId
        // is NOT a usable launch id (Valve steam-for-linux#9463).
        steamLaunchId: data.sikarugir?.steamLaunchId,
        windowsExecutable,
        windowsWorkingDirectory,
      },
    };
    saveLibraryInfo(updated.appID, updated);
    return updated;
  });
