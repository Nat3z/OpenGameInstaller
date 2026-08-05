import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystemError, formatError } from '@ogi/errors';
import { Effect } from 'effect';
import { dialog, ipcMain, shell } from 'electron';
import { extraction } from 'ogi-addon';
import { sendIPCMessage } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { procedure, router } from '@/electron/rpc/router-core.js';
import {
  runEffectBoundary as runBoundary,
  runSyncBoundary,
} from '@/electron/runtime.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

const resolvePath = (value: string): string =>
  value.startsWith('./') ? join(__dirname, value) : value;

const fsTry = <A>(
  path: string,
  operation: () => A
): Effect.Effect<A, FileSystemError> =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      new FileSystemError({ message: formatError(cause), path, cause }),
  });

const fsTryPromise = <A>(
  path: string,
  operation: () => Promise<A>
): Effect.Effect<A, FileSystemError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new FileSystemError({ message: formatError(cause), path, cause }),
  });

const extractArchive = (arg: {
  rarFilePath?: string;
  zipFilePath?: string;
  outputDir: string;
  downloadId?: string;
}) =>
  Effect.gen(function* () {
    const archivePath = arg.rarFilePath ?? arg.zipFilePath;
    if (!archivePath) {
      return yield* Effect.fail(
        new FileSystemError({ message: 'Archive path is required' })
      );
    }
    const exists = yield* fsTry(archivePath, () => fs.existsSync(archivePath));
    if (!exists) {
      return yield* Effect.fail(
        new FileSystemError({
          message: 'Archive file does not exist',
          path: archivePath,
        })
      );
    }
    yield* fsTry(arg.outputDir, () =>
      fs.mkdirSync(arg.outputDir, { recursive: true })
    );
    if (arg.downloadId) {
      sendIPCMessage('setup:log', {
        id: arg.downloadId,
        log: [
          'Starting archive extraction...',
          'Using ogi-addon extraction helper...',
        ],
      });
    }
    yield* extraction(archivePath, arg.outputDir, (progress) => {
      if (arg.downloadId) {
        sendIPCMessage('processing:progress', {
          id: arg.downloadId,
          phase: 'Extracting archive',
          progress,
        });
      }
    }).pipe(
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
    return arg.outputDir;
  });

export default function handler() {
  ipcMain.on('fs:read', (event, arg: string) => {
    const path = resolvePath(String(arg));
    event.returnValue = runSyncBoundary(
      fsTry(path, () => fs.readFileSync(path, 'utf-8'))
    );
  });

  ipcMain.on('fs:exists', (event, arg: string) => {
    const path = resolvePath(String(arg));
    event.returnValue = runSyncBoundary(fsTry(path, () => fs.existsSync(path)));
  });

  ipcMain.on(
    'fs:write',
    (event, arg: { path: string; data: string | Uint8Array }) => {
      const path = resolvePath(String(arg.path));
      event.returnValue = runSyncBoundary(
        fsTry(path, () => {
          fs.writeFileSync(path, arg.data);
          return 'success' as const;
        })
      );
    }
  );

  ipcMain.on('fs:mkdir', (event, arg: string) => {
    const path = resolvePath(String(arg));
    event.returnValue = runSyncBoundary(
      fsTry(path, () => {
        fs.mkdirSync(path, { recursive: true });
        return 'success' as const;
      })
    );
  });

  ipcMain.on('fs:show-file-loc', (event, value: string) => {
    const path = resolvePath(String(value));
    event.returnValue = runSyncBoundary(
      fsTry(path, () => {
        if (!fs.existsSync(path)) return false;
        shell.showItemInFolder(path);
        return true;
      })
    );
  });

  const asyncRouter = router(
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
    procedure(ElectronRpc.fs.getFilesInDir, (arg: string) => {
      const path = resolvePath(String(arg));
      return runBoundary(fsTry(path, () => fs.readdirSync(path)));
    }),
    procedure(ElectronRpc.fs.deleteAsync, (arg: string) => {
      const path = resolvePath(String(arg));
      return runBoundary(
        fsTryPromise(path, () =>
          fsAsync.rm(path, { recursive: true, force: true })
        ).pipe(Effect.as('success' as const))
      );
    }),
    procedure(
      ElectronRpc.fs.move,
      (arg: { source: string; destination: string }) => {
        const source = resolvePath(arg.source);
        const destination = resolvePath(arg.destination);
        return runBoundary(
          fsTryPromise(source, () => fsAsync.rename(source, destination)).pipe(
            Effect.as('success' as const)
          )
        );
      }
    ),
    procedure(
      ElectronRpc.fs.unrar,
      (arg: Parameters<typeof extractArchive>[0]) =>
        runBoundary(extractArchive(arg))
    ),
    procedure(
      ElectronRpc.fs.unzip,
      (arg: Parameters<typeof extractArchive>[0]) =>
        runBoundary(extractArchive(arg))
    )
  );

  ipcMain.on('fs:delete:sync', (event, arg: string) => {
    const path = resolvePath(String(arg));
    event.returnValue = runSyncBoundary(
      fsTry(path, () => {
        fs.rmSync(path, { recursive: true, force: true });
        return 'success' as const;
      })
    );
  });

  ipcMain.on('fs:stat', (event, arg: { path: string }) => {
    event.returnValue = runSyncBoundary(
      fsTry(arg.path, () => {
        const stat = fs.statSync(arg.path);
        return {
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          isSymbolicLink: stat.isSymbolicLink(),
          isBlockDevice: stat.isBlockDevice(),
          isCharacterDevice: stat.isCharacterDevice(),
          isFIFO: stat.isFIFO(),
          isSocket: stat.isSocket(),
        };
      })
    );
  });

  return asyncRouter;
}
