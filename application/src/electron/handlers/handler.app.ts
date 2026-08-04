import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import {
  FileSystemError,
  formatError,
  HttpError,
  PlatformError,
} from '@ogi/errors';
import axios, { type AxiosRequestConfig } from 'axios';
import { Effect } from 'effect';
import { app } from 'electron';
import { registerLibraryHandlers } from '@/electron/handlers/handler.library.js';
import { registerRedistributableHandlers } from '@/electron/handlers/handler.redists.js';
import { registerSteamHandlers } from '@/electron/handlers/handler.steam.js';
import { getEffectiveOnlineState } from '@/electron/lib/online.js';
import { currentScreens, screenInputCallbacks } from '@/electron/main.js';
import { __dirname, isDev } from '@/electron/manager/manager.paths.js';
import {
  ipcProcedure,
  mergeRouters,
  procedure,
  router,
} from '@/electron/rpc/router-core.js';
import { runEffectBoundary as runBoundary } from '@/electron/runtime.js';
import { addonServer } from '@/electron/server/addon-server.js';
import type { OperatingSystem } from '@/lib/electron-rpc.js';
import { getCurrentUsername } from './helpers.app/platform.js';

export function escapeShellArg(arg: string): string {
  return arg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

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
    const targetIcon = path.join(appDirPath, 'favicon.png');
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

const axiosRequest = (
  options: AxiosRequestConfig
): Effect.Effect<
  { data: unknown; status: number; success: boolean },
  HttpError
> =>
  Effect.tryPromise({
    try: async () => {
      if (
        options.data &&
        options.headers &&
        (options.headers['Content-Type'] === 'multipart/form-data' ||
          options.headers['Content-Type'] ===
            'application/x-www-form-urlencoded')
      ) {
        const formData = new FormData();
        for (const [key, value] of Object.entries(options.data))
          formData.append(key, value as string);
        options = { ...options, data: formData };
      }
      const response = await axios(options);
      return {
        data: response.data,
        status: response.status,
        success: response.status >= 200 && response.status < 300,
      };
    },
    catch: (cause: unknown) =>
      new HttpError({
        message: axios.isAxiosError(cause) ? cause.message : formatError(cause),
        statusCode: axios.isAxiosError(cause)
          ? (cause.response?.status ?? 500)
          : 500,
        url: options.url,
      }),
  });

export default function handler(mainWindow: Electron.BrowserWindow) {
  const appRouter = router(
    procedure('app.close', () => mainWindow?.close()),
    procedure('app.hideWindow', () => mainWindow?.hide()),
    procedure('app.showWindow', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    }),
    procedure('app.minimize', () => mainWindow?.minimize()),
    procedure('app.quit', () => app.quit()),
    procedure('app.getOS', (): OperatingSystem => {
      if (
        process.platform === 'darwin' ||
        process.platform === 'linux' ||
        process.platform === 'win32'
      ) {
        return process.platform;
      }
      throw new Error(`Unsupported Electron platform '${process.platform}'`);
    }),
    procedure('app.grantRootPassword', (_password: string) => {
      throw new Error('Root password grants are not implemented');
    }),
    procedure(
      'app.openSteamKeyboard',
      (_options: { x: number; y: number; width: number; height: number }) =>
        false
    ),
    ipcProcedure('app.axios', (_, options: AxiosRequestConfig) =>
      runBoundary(
        axiosRequest(options).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              data: error.message,
              status: error.statusCode,
              success: false,
            })
          )
        )
      )
    ),
    procedure('app.isSteamDeck', () =>
      runBoundary(
        Effect.try({
          try: () =>
            process.platform === 'linux' &&
            getCurrentUsername()?.toLowerCase() === 'deck',
          catch: (cause) =>
            new PlatformError({
              message: formatError(cause),
              platform: process.platform,
            }),
        })
      )
    ),
    ipcProcedure('app.inputSend', (_, data: { id: string; data: any }) =>
      runBoundary(
        Effect.sync(() => {
          currentScreens.set(data.id, data.data);
          screenInputCallbacks.get(data.id)?.(data.data);
          screenInputCallbacks.delete(data.id);
        })
      )
    ),
    procedure('app.isOnline', () =>
      runBoundary(Effect.sync(() => getEffectiveOnlineState().effectiveOnline))
    ),
    procedure('app.getAddonPath', (addonID: string) =>
      runBoundary(
        Effect.sync(() => addonServer.getClient(addonID)?.filePath ?? null)
      )
    ),
    procedure('app.getAddonIcon', (addonID: string) =>
      runBoundary(
        Effect.try({
          try: () => {
            const client = addonServer.getClient(addonID);
            if (!client?.filePath) return null;
            const addonJson = JSON.parse(
              fs.readFileSync(join(client.filePath, 'addon.json'), 'utf-8')
            ) as { icon?: string };
            if (!addonJson.icon) return null;
            const iconPath = join(client.filePath, addonJson.icon);
            return fs.existsSync(iconPath) ? iconPath : null;
          },
          catch: (cause) =>
            new FileSystemError({ message: formatError(cause), cause }),
        })
      )
    ),
    procedure('app.getLocalImage', (requestPath: string) =>
      runBoundary(
        Effect.gen(function* () {
          if (!fs.existsSync(requestPath)) return null;
          const allowedDirs = [
            join(__dirname, 'addons'),
            join(__dirname, 'public'),
            join(__dirname, 'config'),
            ...Array.from(addonServer.getConnections()).flatMap((connection) =>
              connection.filePath ? [connection.filePath] : []
            ),
          ].map((directory) => path.resolve(directory));
          const realPath = yield* Effect.try({
            try: () => fs.realpathSync(requestPath),
            catch: (cause) =>
              new FileSystemError({
                message: formatError(cause),
                path: requestPath,
                cause,
              }),
          });
          const allowed = allowedDirs.some((directory) => {
            const relative = path.relative(directory, realPath);
            return (
              relative === '' ||
              (!relative.startsWith('..') && !path.isAbsolute(relative))
            );
          });
          if (!allowed)
            return yield* Effect.fail(
              new FileSystemError({
                message: 'Path is outside allowed directories',
                path: realPath,
              })
            );
          const ext = path.extname(realPath).slice(1).toLowerCase();
          const mimeType =
            (
              {
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                png: 'image/png',
                gif: 'image/gif',
                webp: 'image/webp',
                bmp: 'image/bmp',
                svg: 'image/svg+xml',
              } as Record<string, string>
            )[ext] ?? 'image/png';
          const buffer = yield* Effect.tryPromise({
            try: () => fsAsync.readFile(realPath),
            catch: (cause) =>
              new FileSystemError({
                message: formatError(cause),
                path: realPath,
                cause,
              }),
          });
          return `data:${mimeType};base64,${buffer.toString('base64')}`;
        })
      )
    ),
    procedure('app.addToDesktop', () => runBoundary(addToDesktop()))
  );

  return mergeRouters(
    appRouter,
    registerSteamHandlers(mainWindow),
    registerLibraryHandlers(mainWindow),
    registerRedistributableHandlers(mainWindow)
  );
}
