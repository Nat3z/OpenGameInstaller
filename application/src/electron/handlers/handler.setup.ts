import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystemError, formatError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { extraction } from 'ogi-addon';
import { getDatabase } from '@/electron/database/index.js';
import {
  fsTry,
  fsTryPromise,
  requireAbsolute,
} from '@/electron/handlers/handler.fs.js';
import { isProtectedDeletePath } from '@/electron/lib/delete-guards.js';
import { getPersistedFilePaths } from '@/electron/lib/download-paths.js';
import { sendIPCMessage } from '@/electron/main.js';
import { procedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary as runBoundary } from '@/electron/runtime.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/** Subdirectory a game's previous install is parked in during an update. */
const OLD_FILES = 'old_files';

/** Guard against a symlink loop or a pathological single-child chain. */
const MAX_CONTENT_ROOT_DEPTH = 10;

/**
 * Directories the renderer may operate on: the download location, every
 * owned game's install folder, and where in-flight or failed downloads landed.
 * Anything else is refused so a compromised renderer cannot reach into
 * unrelated user data.
 */
const managedRoots = (): string[] => {
  const database = getDatabase();
  return [
    database.getSettings().fileDownloadLocation,
    ...database.listGames().map((game) => game.cwd),
    ...database
      .listDownloads()
      .map((record) => record.downloadInfo.downloadPath),
    ...database
      .listFailedSetups()
      .map((setup) => setup.downloadInfo.downloadPath),
  ].filter((root) => root.trim() !== '');
};

const requireManaged = (
  value: string
): Effect.Effect<string, FileSystemError> =>
  requireAbsolute(value).pipe(
    Effect.filterOrFail(
      (target) =>
        isProtectedDeletePath(target, { exact: [], subtrees: managedRoots() }),
      (target) =>
        new FileSystemError({
          message: 'Path is outside the directories OpenGameInstaller manages',
          path: target,
        })
    )
  );

const resolveContentRoot = (
  directory: string
): Effect.Effect<string, FileSystemError> =>
  fsTry(directory, () => {
    let current = directory.replace(/[/\\]+$/, '');
    for (let depth = 0; depth < MAX_CONTENT_ROOT_DEPTH; depth++) {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      if (entries.length !== 1 || !entries[0].isDirectory()) break;
      current = join(current, entries[0].name);
    }
    return current;
  });

const stageOldFiles = (arg: { directory: string; keep: string[] }) =>
  Effect.gen(function* () {
    const directory = yield* requireManaged(arg.directory);
    const keep = new Set([...arg.keep, OLD_FILES]);
    const entries = yield* fsTry(directory, () => fs.readdirSync(directory));
    const toMove = entries.filter((entry) => !keep.has(entry));
    if (toMove.length === 0) {
      return { staged: false, moved: 0, failed: 0 };
    }

    const target = join(directory, OLD_FILES);
    yield* fsTry(target, () => fs.mkdirSync(target, { recursive: true }));

    // A rename that fails is counted, never fatal: the caller decides whether
    // a partially staged directory is safe to continue with.
    let moved = 0;
    let failed = 0;
    for (const entry of toMove) {
      const renamed = yield* fsTryPromise(entry, () =>
        fsAsync.rename(join(directory, entry), join(target, entry))
      ).pipe(
        Effect.as(true),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            logger.sync.warn('[setup] Could not stage old file', error);
            return false;
          })
        )
      );
      if (renamed) moved++;
      else failed++;
    }
    return { staged: true, moved, failed };
  });

const revertOldFiles = (directory: string) =>
  Effect.gen(function* () {
    const root = yield* requireManaged(directory);
    const source = join(root, OLD_FILES);
    const exists = yield* fsTry(source, () => fs.existsSync(source));
    if (!exists) return true;

    const entries = yield* fsTry(source, () => fs.readdirSync(source));
    let allMoved = true;
    for (const entry of entries) {
      const result = yield* fsTryPromise(entry, () =>
        fsAsync.rename(join(source, entry), join(root, entry))
      ).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false))
      );
      if (!result) allMoved = false;
    }
    if (allMoved) {
      yield* fsTryPromise(source, () =>
        fsAsync.rm(source, { recursive: true, force: true })
      );
    }
    return allMoved;
  });

const extractArchive = (arg: {
  archivePath: string;
  outputDir: string;
  downloadId?: string;
}) =>
  Effect.gen(function* () {
    const archivePath = yield* requireManaged(arg.archivePath);
    const outputDir = yield* requireManaged(arg.outputDir);
    const exists = yield* fsTry(archivePath, () => fs.existsSync(archivePath));
    if (!exists) {
      return yield* Effect.fail(
        new FileSystemError({
          message: 'Archive file does not exist',
          path: archivePath,
        })
      );
    }
    yield* fsTry(outputDir, () => fs.mkdirSync(outputDir, { recursive: true }));
    if (arg.downloadId) {
      sendIPCMessage('setup:log', {
        id: arg.downloadId,
        log: [
          'Starting archive extraction...',
          'Using ogi-addon extraction helper...',
        ],
      });
    }
    // Throttle progress IPC: per-file move callbacks can fire thousands of
    // times for large games. Always let stage changes and completion through.
    let lastProgressSent = 0;
    let lastStage: string | undefined;
    yield* fsTryPromise(outputDir, () =>
      extraction(archivePath, outputDir, (progress, stage) => {
        if (!arg.downloadId) return;
        const now = Date.now();
        if (
          stage === lastStage &&
          progress !== 1 &&
          now - lastProgressSent < 100
        )
          return;
        lastProgressSent = now;
        lastStage = stage;
        sendIPCMessage('processing:progress', {
          id: arg.downloadId,
          phase: stage === 'moving' ? 'Moving files' : 'Extracting archive',
          progress,
        });
      })
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (arg.downloadId) {
            sendIPCMessage('setup:log', {
              id: arg.downloadId,
              log: [`Archive extraction failed: ${formatError(error)}`],
            });
          }
        })
      )
    );
    if (arg.downloadId) {
      sendIPCMessage('setup:log', {
        id: arg.downloadId,
        log: ['Archive extraction completed successfully'],
      });
    }
    // The archive is dead weight once extracted; a failure to remove it must
    // not fail the setup.
    yield* fsTryPromise(archivePath, () =>
      fsAsync.rm(archivePath, { force: true })
    ).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() =>
          logger.sync.warn('[setup] Could not delete archive', error)
        )
      )
    );
    return outputDir;
  });

const deleteDownloadFiles = (downloadId: string) =>
  Effect.gen(function* () {
    const record = yield* Effect.sync(() =>
      getDatabase().getDownload(downloadId)
    );
    if (!record) return;
    const paths = getPersistedFilePaths(record.downloadInfo);
    for (const target of paths) {
      yield* fsTryPromise(target, () =>
        fsAsync.rm(target, { recursive: true, force: true })
      ).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() =>
            logger.sync.warn('[setup] Could not delete download file', error)
          )
        )
      );
    }
  });

export default function handler() {
  return router(
    procedure(
      ElectronRpc.setup.stageOldFiles,
      (arg: { directory: string; keep: string[] }) =>
        runBoundary(stageOldFiles(arg))
    ),
    procedure(ElectronRpc.setup.revertOldFiles, (directory: string) =>
      runBoundary(revertOldFiles(directory))
    ),
    procedure(ElectronRpc.setup.discardOldFiles, (directory: string) =>
      runBoundary(
        requireManaged(directory).pipe(
          Effect.flatMap((root) => {
            const target = join(root, OLD_FILES);
            return fsTryPromise(target, () =>
              fsAsync.rm(target, { recursive: true, force: true })
            );
          }),
          Effect.asVoid
        )
      )
    ),
    procedure(ElectronRpc.setup.resolveContentRoot, (directory: string) =>
      runBoundary(
        requireManaged(directory).pipe(Effect.flatMap(resolveContentRoot))
      )
    ),
    procedure(
      ElectronRpc.setup.findArchive,
      (directory: string, kind: 'rar' | 'zip') =>
        runBoundary(
          requireManaged(directory).pipe(
            Effect.flatMap((root) =>
              fsTry(root, (): string | null => {
                const suffix = `.${kind}`;
                const stat = fs.statSync(root);
                if (stat.isFile()) {
                  return root.toLowerCase().endsWith(suffix) ? root : null;
                }
                const match = fs
                  .readdirSync(root)
                  .find((entry) => entry.toLowerCase().endsWith(suffix));
                return match ? join(root, match) : null;
              })
            )
          )
        )
    ),
    procedure(
      ElectronRpc.setup.extractArchive,
      (arg: { archivePath: string; outputDir: string; downloadId?: string }) =>
        runBoundary(extractArchive(arg))
    ),
    procedure(ElectronRpc.setup.deleteDownloadFiles, (downloadId: string) =>
      runBoundary(deleteDownloadFiles(downloadId).pipe(Effect.asVoid))
    ),
    procedure(ElectronRpc.setup.listDlls, (directory: string) =>
      runBoundary(
        requireManaged(directory).pipe(
          Effect.flatMap((root) =>
            fsTry(root, () =>
              fs.readdirSync(root).filter((entry) => /\.dll$/i.test(entry))
            )
          )
        )
      )
    )
  );
}
