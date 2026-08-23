import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSystemError, formatError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { app } from 'electron';
import { __dirname, isDev } from '@/electron/manager/manager.paths.js';

export const addToDesktop = (): Effect.Effect<
  { success: true; path: string } | { success: false; error: string },
  FileSystemError
> => {
  if (process.platform === 'win32') {
    return Effect.succeed({
      success: false,
      error: 'This feature is only available on Linux',
    });
  }
  return Effect.gen(function* () {
    let appDirPath = isDev()
      ? `${app.getAppPath()}/../`
      : path.dirname(process.execPath);
    if (process.platform === 'linux') appDirPath = './';
    let execPath = path.resolve(
      appDirPath,
      fs.readdirSync(appDirPath).find((file) => file.endsWith('.AppImage')) ??
        './OpenGameInstaller.AppImage'
    );
    const desktopDir = path.join(os.homedir(), 'Desktop');
    const desktopFilePath = path.join(desktopDir, 'OpenGameInstaller.desktop');
    yield* Effect.tryPromise({
      try: () => fsAsync.mkdir(desktopDir, { recursive: true }),
      catch: (cause) =>
        new FileSystemError({
          message: formatError(cause),
          path: desktopDir,
          cause,
        }),
    });
    const setupPath = path.resolve(
      path.resolve(appDirPath, '..'),
      'OpenGameInstaller-Setup.AppImage'
    );
    if (fs.existsSync(setupPath)) execPath = setupPath;
    const sourceIcon = app.isPackaged
      ? path.join(app.getPath('exe'), '..', 'opengameinstaller-gui.png')
      : path.join(__dirname, '..', '..', 'public', 'favicon.png');
    // The icon must live in the OGI data dir: the updater wipes the update/
    // cwd on every update, which would delete an icon stored next to the app.
    const targetIcon = path.join(__dirname, 'favicon.png');
    yield* Effect.tryPromise({
      try: () => fsAsync.copyFile(sourceIcon, targetIcon),
      catch: (cause) =>
        new FileSystemError({
          message: formatError(cause),
          path: sourceIcon,
          cause,
        }),
    });
    const absoluteIcon = path.resolve(targetIcon);
    const desktopContent = `[Desktop Entry]\nType=Application\nName=OpenGameInstaller\nExec=${execPath}\nPath=${execPath.endsWith('-Setup.AppImage') ? path.resolve(appDirPath, '..') : path.resolve(appDirPath)}\nIcon=${absoluteIcon}\nTerminal=false\nCategories=Game;\nStartupNotify=true\n`;
    yield* Effect.tryPromise({
      try: () =>
        fsAsync.writeFile(desktopFilePath, desktopContent, { mode: 0o755 }),
      catch: (cause) =>
        new FileSystemError({
          message: formatError(cause),
          path: desktopFilePath,
          cause,
        }),
    });
    return { success: true as const, path: desktopFilePath };
  });
};
