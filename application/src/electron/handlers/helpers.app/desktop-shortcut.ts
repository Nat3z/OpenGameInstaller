import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSystemError, formatError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { app } from 'electron';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { getOgiExecutablePath } from './platform.js';

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
    // Resolve from the running AppImage, not cwd: Steam shortcut launches run
    // with cwd set to the game's directory.
    const appImagePath = getOgiExecutablePath();
    const setupPath = path.resolve(
      path.dirname(appImagePath),
      '..',
      'OpenGameInstaller-Setup.AppImage'
    );
    const execPath = fs.existsSync(setupPath) ? setupPath : appImagePath;
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
    const desktopContent = `[Desktop Entry]\nType=Application\nName=OpenGameInstaller\nExec=${execPath}\nPath=${path.dirname(execPath)}\nIcon=${absoluteIcon}\nTerminal=false\nCategories=Game;\nStartupNotify=true\n`;
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
