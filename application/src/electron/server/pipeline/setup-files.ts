import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import { join } from 'node:path';
import { SetupFiles } from '@ogi-sdk/core';
import { FileSystemError, formatError } from '@ogi-sdk/errors';
import { Effect, Layer } from 'effect';
import { fsTry, fsTryPromise } from '@/electron/handlers/handler.fs.js';
import {
  extractArchive,
  requireDownloadPath,
  resolveContentRoot,
  revertOldFiles,
  stageOldFiles,
} from '@/electron/handlers/handler.setup.js';
import { type AppEffect, runElectronEffect } from '@/electron/runtime.js';

/**
 * Core's setup-files adapter: the same guarded filesystem steps the renderer
 * used over RPC. Every path is checked to sit under a download root first.
 */
const onApp = <A, E>(
  effect: AppEffect<A, E>
): Effect.Effect<A, FileSystemError> =>
  Effect.promise(() => runElectronEffect(Effect.either(effect))).pipe(
    Effect.flatMap((result) =>
      result._tag === 'Right'
        ? Effect.succeed(result.right)
        : Effect.fail(
            result.left instanceof FileSystemError
              ? result.left
              : new FileSystemError({
                  message: formatError(result.left),
                  cause: result.left,
                })
          )
    )
  );

export const SetupFilesFromHandlers = Layer.succeed(SetupFiles, {
  stageOldFiles: (directory, keep) =>
    onApp(stageOldFiles({ directory, keep: [...keep] })),
  revertOldFiles: (directory) => onApp(revertOldFiles(directory)),
  discardOldFiles: (directory) =>
    onApp(
      requireDownloadPath(directory).pipe(
        Effect.flatMap((root) => {
          const target = join(root, 'old_files');
          return fsTryPromise(target, () =>
            fsAsync.rm(target, { recursive: true, force: true })
          );
        }),
        Effect.asVoid
      )
    ),
  contentRoot: (directory) =>
    onApp(
      requireDownloadPath(directory).pipe(Effect.flatMap(resolveContentRoot))
    ),
  findArchive: (path, kind) =>
    onApp(
      requireDownloadPath(path).pipe(
        Effect.flatMap((root) =>
          fsTry(root, (): string | null => {
            const suffix = `.${kind}`;
            if (!fs.existsSync(root)) return null;
            if (fs.statSync(root).isFile())
              return root.toLowerCase().endsWith(suffix) ? root : null;
            const match = fs
              .readdirSync(root)
              .find((entry) => entry.toLowerCase().endsWith(suffix));
            return match ? join(root, match) : null;
          })
        )
      )
    ),
  extract: (id, archive, outputDir) =>
    onApp(extractArchive({ archivePath: archive, outputDir, downloadId: id })),
  remove: (paths) =>
    onApp(
      Effect.forEach(
        paths,
        (path) =>
          requireDownloadPath(path).pipe(
            Effect.flatMap((target) =>
              fsTryPromise(target, () =>
                fsAsync.rm(target, { recursive: true, force: true })
              )
            ),
            // One file outside the roots must not keep the rest on disk.
            Effect.ignore
          ),
        { discard: true }
      )
    ),
});
