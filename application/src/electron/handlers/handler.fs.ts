import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileSystemError, formatError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { dialog, shell } from 'electron';
import { procedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary as runBoundary } from '@/electron/runtime.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

/**
 * The renderer never sees the app data directory, so every path it hands us is
 * a user-chosen absolute location.
 */
export const requireAbsolute = (
  value: string
): Effect.Effect<string, FileSystemError> =>
  path.isAbsolute(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new FileSystemError({ message: 'Path must be absolute', path: value })
      );

export const fsTry = <A>(
  target: string,
  operation: () => A
): Effect.Effect<A, FileSystemError> =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      new FileSystemError({ message: formatError(cause), path: target, cause }),
  });

export const fsTryPromise = <A>(
  target: string,
  operation: () => Promise<A>
): Effect.Effect<A, FileSystemError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new FileSystemError({ message: formatError(cause), path: target, cause }),
  });

export default function handler() {
  return router(
    procedure(
      ElectronRpc.fs.dialog.showOpenDialog,
      (options: Electron.OpenDialogOptions) =>
        runBoundary(
          Effect.tryPromise({
            try: () => dialog.showOpenDialog(options),
            catch: (cause) =>
              new FileSystemError({ message: formatError(cause), cause }),
          }).pipe(Effect.map((result) => result.filePaths[0]))
        )
    ),
    procedure(
      ElectronRpc.fs.dialog.showSaveDialog,
      (options: Electron.SaveDialogOptions) =>
        runBoundary(
          Effect.tryPromise({
            try: () => dialog.showSaveDialog(options),
            catch: (cause) =>
              new FileSystemError({ message: formatError(cause), cause }),
          }).pipe(Effect.map((result) => result.filePath))
        )
    ),
    procedure(ElectronRpc.fs.pathExists, (target: string) =>
      runBoundary(
        requireAbsolute(target).pipe(
          Effect.flatMap((resolved) =>
            fsTry(resolved, () => fs.existsSync(resolved))
          )
        )
      )
    ),
    procedure(ElectronRpc.fs.showItemInFolder, (target: string) =>
      runBoundary(
        requireAbsolute(target).pipe(
          Effect.flatMap((resolved) =>
            fsTry(resolved, () => {
              if (!fs.existsSync(resolved)) return false;
              shell.showItemInFolder(resolved);
              return true;
            })
          )
        )
      )
    )
  );
}
