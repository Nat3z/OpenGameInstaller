import { exec } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  FileSystemError,
  formatError,
  HttpError,
  PlatformError,
} from '@ogi/errors';
import axios from 'axios';
import { Effect } from 'effect';
import {
  getSteamGridDbConfigPath,
  writeSteamGridDbKey,
} from '@/electron/lib/steam-grid-db.js';
import { sendIPCMessage, sendNotification } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { procedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary } from '@/electron/runtime.js';
import { IS_NIXOS } from '@/electron/startup.js';

const log = (content: string): void => {
  sendIPCMessage('oobe:log', content);
  console.log(`[oobe]${content}`);
};

const command = (
  executable: string,
  options?: { cwd?: string }
): Effect.Effect<{ stdout: string; stderr: string }, PlatformError> =>
  Effect.async<{ stdout: string; stderr: string }, PlatformError>((resume) => {
    const child = exec(executable, options ?? {}, (error, stdout, stderr) => {
      if (error) {
        resume(
          Effect.fail(
            new PlatformError({
              message: error.message,
              platform: process.platform,
            })
          )
        );
      } else {
        resume(Effect.succeed({ stdout, stderr }));
      }
    });
    return Effect.sync(() => child.kill());
  }).pipe(
    Effect.tap(({ stdout, stderr }) =>
      Effect.sync(() => {
        log(stdout);
        log(stderr);
      })
    )
  );

const commandExists = (executable: string): Effect.Effect<boolean> =>
  command(executable).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false))
  );

const download = (
  url: string,
  destination: string
): Effect.Effect<void, HttpError | FileSystemError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' }),
      catch: (cause: unknown) =>
        new HttpError({
          message: axios.isAxiosError(cause)
            ? cause.message
            : formatError(cause),
          statusCode: axios.isAxiosError(cause)
            ? (cause.response?.status ?? 0)
            : 0,
          url,
        }),
    });
    yield* Effect.tryPromise({
      try: () => fs.writeFile(destination, Buffer.from(response.data)),
      catch: (cause) =>
        new FileSystemError({
          message: formatError(cause),
          path: destination,
          cause,
        }),
    });
  });

const notify = (message: string, type: 'info' | 'error'): void =>
  sendNotification({
    message,
    id: Math.random().toString(36).substring(7),
    type,
  });

const runInstaller = (
  installerUrl: string,
  installerPath: string,
  installCommand: string,
  successMessage: string
): Effect.Effect<void, HttpError | FileSystemError | PlatformError> =>
  Effect.gen(function* () {
    yield* download(installerUrl, installerPath);
    log(`Downloaded ${installerPath}`);
    yield* command(installCommand);
    yield* Effect.tryPromise({
      try: () => fs.rm(installerPath, { force: true }),
      catch: (cause) =>
        new FileSystemError({
          message: formatError(cause),
          path: installerPath,
          cause,
        }),
    });
    notify(successMessage, 'info');
  });

const downloadTools = (): Effect.Effect<readonly [boolean, boolean]> =>
  Effect.gen(function* () {
    let clean = true;
    let restart = false;
    const attempt = <E>(effect: Effect.Effect<void, E>) =>
      effect.pipe(
        Effect.either,
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result._tag === 'Left') {
              clean = false;
              log(`Error: ${formatError(result.left)}`);
            }
          })
        )
      );

    if (
      process.platform === 'win32' &&
      !(yield* commandExists('"C:\\Program Files\\7-Zip\\7z.exe" --help'))
    ) {
      const result = yield* attempt(
        runInstaller(
          'https://7-zip.org/a/7z2407-x64.exe',
          join(__dirname, '7z-install.exe'),
          '7z-install.exe /S /D="C:\\Program Files\\7-Zip"',
          'Successfully installed 7zip.'
        )
      );
      if (result._tag === 'Right') restart = true;
    }

    if (!(yield* commandExists('git --version'))) {
      if (process.platform === 'win32') {
        const installerPath = join(__dirname, 'git-install.exe');
        const result = yield* attempt(
          runInstaller(
            'https://github.com/git-for-windows/git/releases/download/v2.46.0.windows.1/Git-2.46.0-64-bit.exe',
            installerPath,
            `${installerPath} /VERYSILENT /NORESTART /NOCANCEL`,
            'Successfully installed git.'
          )
        );
        if (result._tag === 'Right') restart = true;
      } else {
        clean = false;
        notify(
          'Missing Git and automatic installation is not supported.',
          'error'
        );
      }
    }

    if (!(yield* commandExists('bun --version'))) {
      const install =
        process.platform === 'win32'
          ? command('powershell -c "irm bun.sh/install.ps1 | iex"')
          : process.platform === 'linux' && !IS_NIXOS
            ? command('curl -fsSL https://bun.sh/install | bash').pipe(
                Effect.zipRight(
                  command(
                    `echo "export PATH=$PATH:/home/${os.userInfo().username}/.bun/bin" >> ~/.bashrc`
                  )
                )
              )
            : Effect.fail(
                new PlatformError({
                  message: 'Automatic Bun installation is unsupported',
                  platform: process.platform,
                })
              );
      const result = yield* attempt(install.pipe(Effect.asVoid));
      if (result._tag === 'Right') restart = true;
    } else if (!IS_NIXOS) {
      yield* command('bun upgrade').pipe(Effect.ignore);
    }
    return [clean, restart] as const;
  });

export default function OOBEHandler() {
  return router(
    procedure('oobe.downloadTools', () => runEffectBoundary(downloadTools())),
    procedure('oobe.setSteamGridDBKey', (key: string) =>
      runEffectBoundary(
        Effect.try({
          try: () => writeSteamGridDbKey(key),
          catch: (cause) =>
            new FileSystemError({
              message: formatError(cause),
              path: getSteamGridDbConfigPath(),
              cause,
            }),
        }).pipe(
          Effect.as(true),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              log(`Error: ${formatError(error)}`);
              return false;
            })
          )
        )
      )
    )
  );
}
