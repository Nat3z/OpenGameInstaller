import { exec, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  FileSystemError,
  formatError,
  HttpError,
  PlatformError,
} from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import axios from 'axios';
import { Effect } from 'effect';
import { getBunSetupAction } from '@/electron/lib/bun-setup.js';
import {
  getBunProvenance,
  resolveBun,
  resolveGit,
  resolveHomebrew,
  resolveSikarugir,
  resolveSupportedHomebrew,
} from '@/electron/lib/macos-tools.js';
import {
  SikarugirRuntime,
  SikarugirRuntimeLive,
} from '@/electron/lib/sikarugir/index.js';
import {
  getSteamGridDbConfigPath,
  writeSteamGridDbKey,
} from '@/electron/lib/steam-grid-db.js';
import { sendIPCMessage, sendNotification } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { procedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary } from '@/electron/runtime.js';
import { IS_NIXOS } from '@/electron/startup.js';
import {
  ElectronRpc,
  type HomebrewPollResult,
  type SikarugirActionResult,
  type SikarugirInstallResult,
  type SikarugirProvisionState,
  type WindowsSupportStatus,
} from '@/lib/electron-rpc.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

const log = (content: string): void => {
  sendIPCMessage('oobe:log', content);
  logger.sync.info(`[oobe]${content}`);
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

const commandArgs = (
  executable: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Effect.Effect<void, PlatformError> =>
  Effect.async<void, PlatformError>((resume) => {
    let settled = false;
    const finish = (effect: Effect.Effect<void, PlatformError>): void => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const child = spawn(executable, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data: Buffer) => log(data.toString()));
    child.stderr.on('data', (data: Buffer) => log(data.toString()));
    child.on('error', (cause) =>
      finish(
        Effect.fail(
          new PlatformError({
            message: cause.message,
            platform: process.platform,
          })
        )
      )
    );
    child.on('close', (code) =>
      finish(
        code === 0
          ? Effect.void
          : Effect.fail(
              new PlatformError({
                message: `${executable} exited with code ${code ?? 'unknown'}`,
                platform: process.platform,
              })
            )
      )
    );
    return Effect.sync(() => child.kill());
  });

const commandArgsExists = (
  executable: string,
  args: readonly string[]
): Effect.Effect<boolean> =>
  commandArgs(executable, args).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false))
  );

const launchTerminal = (script: string): Effect.Effect<void, PlatformError> =>
  commandArgs('/usr/bin/osascript', [
    '-e',
    'tell application "Terminal" to activate',
    '-e',
    `tell application "Terminal" to do script ${JSON.stringify(script)}`,
  ]);

const probeRosetta = (): Effect.Effect<boolean> =>
  commandArgsExists('/usr/bin/arch', ['-x86_64', '/usr/bin/true']);

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

    const brewPath =
      process.platform === 'darwin' ? resolveHomebrew() : undefined;
    const gitPath =
      process.platform === 'darwin' ? resolveGit(brewPath) : undefined;
    const gitInstalled = gitPath
      ? yield* commandArgsExists(gitPath, ['--version'])
      : yield* commandExists('git --version');
    if (!gitInstalled) {
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
        const message =
          'Git is not installed, and OpenGameInstaller cannot install it automatically on this platform. Install Git manually, then try again.';
        clean = false;
        log(`Error: ${message}`);
        notify(message, 'error');
      }
    }

    const resolvedBunPath =
      process.platform === 'darwin' ? resolveBun(brewPath) : undefined;
    const bunInstalled = resolvedBunPath
      ? yield* commandArgsExists(resolvedBunPath, ['--version'])
      : yield* commandExists('bun --version');
    const bunSetup = getBunSetupAction({
      installed: bunInstalled,
      bunPath: resolvedBunPath ?? (bunInstalled ? 'bun' : undefined),
      bunProvenance: getBunProvenance(resolvedBunPath),
      brewPath,
      bunInstallPath: join(os.homedir(), '.bun', 'bin', 'bun'),
      isNixOS: IS_NIXOS,
      platform: process.platform,
      username: os.userInfo().username,
    });
    if (bunSetup.type === 'install') {
      const install = Effect.gen(function* () {
        yield* Effect.forEach(
          bunSetup.commands,
          (executable) => command(executable),
          { discard: true }
        );
        if (bunSetup.executable) {
          yield* commandArgs(bunSetup.executable, ['--version']);
        }
      });
      const result = yield* attempt(install);
      if (result._tag === 'Right' && process.platform !== 'darwin') {
        restart = true;
      }
    } else if (bunSetup.type === 'upgrade') {
      yield* commandArgs(bunSetup.executable, bunSetup.args).pipe(
        Effect.ignore
      );
    } else if (bunSetup.type === 'unsupported') {
      yield* attempt(
        Effect.fail(
          new PlatformError({
            message: IS_NIXOS
              ? 'Bun is not installed. Automatic installation is disabled on NixOS. Install Bun with your system package manager, then try again.'
              : 'Bun is not installed, and OpenGameInstaller cannot install it automatically on this platform. Install Bun manually, then try again.',
            platform: process.platform,
          })
        )
      );
    }
    return [clean, restart] as const;
  });

const getWindowsSupportStatus = (): Effect.Effect<WindowsSupportStatus> =>
  Effect.gen(function* () {
    if (process.platform !== 'darwin') {
      return {
        platform: 'other',
        homebrew: { status: 'unsupported' },
        rosetta: { status: 'unsupported' },
        sikarugir: { status: 'unsupported' },
      };
    }

    const homebrewPath = resolveSupportedHomebrew();
    const sikarugirPath = resolveSikarugir();
    const rosettaReady = process.arch !== 'arm64' || (yield* probeRosetta());
    return {
      platform: 'darwin',
      homebrew: homebrewPath
        ? { status: 'ready', path: homebrewPath }
        : { status: 'missing' },
      rosetta: { status: rosettaReady ? 'ready' : 'action-required' },
      sikarugir: sikarugirPath
        ? { status: 'ready', path: sikarugirPath }
        : { status: 'missing' },
    };
  });

const startHomebrewInstall = (): Effect.Effect<boolean> => {
  if (process.platform !== 'darwin') return Effect.succeed(false);
  const script =
    '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
  return launchTerminal(script).pipe(
    Effect.as(true),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        log(`Error: ${formatError(error)}`);
        return false;
      })
    )
  );
};

const pollHomebrew = (): HomebrewPollResult => {
  if (process.platform !== 'darwin') return { status: 'unsupported' };
  const path = resolveSupportedHomebrew();
  return path ? { status: 'ready', path } : { status: 'missing' };
};

const installRosetta = (): Effect.Effect<
  'ready' | 'installing' | 'launch-failed' | 'unsupported'
> =>
  Effect.gen(function* () {
    if (process.platform !== 'darwin') return 'unsupported' as const;
    if (process.arch !== 'arm64' || (yield* probeRosetta())) {
      return 'ready' as const;
    }
    const result = yield* launchTerminal(
      '/usr/sbin/softwareupdate --install-rosetta --agree-to-license'
    ).pipe(Effect.either);
    if (result._tag === 'Left') {
      log(`Error: ${formatError(result.left)}`);
      return 'launch-failed' as const;
    }
    // The install continues in Terminal; the frontend polls for readiness.
    return (yield* probeRosetta())
      ? ('ready' as const)
      : ('installing' as const);
  });

const installSikarugir = (): Effect.Effect<SikarugirInstallResult> => {
  if (process.platform !== 'darwin') {
    return Effect.succeed({
      success: false,
      message: 'Windows-game support is unsupported on this platform.',
    });
  }
  const brewPath = resolveSupportedHomebrew();
  if (!brewPath) {
    return Effect.succeed({
      success: false,
      message: 'Homebrew is required before installing Sikarugir.',
    });
  }
  return commandArgs(
    brewPath,
    ['install', '--cask', 'Sikarugir-App/sikarugir/sikarugir'],
    {
      env: {
        ...process.env,
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_ENV_HINTS: '1',
      },
    }
  ).pipe(
    Effect.as({
      success: true,
      message: 'Sikarugir Creator installed successfully.',
    }),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        const message = formatError(error);
        log(`Error: ${message}`);
        return { success: false, message };
      })
    )
  );
};

const STEAM_INSTALLER_URL =
  'https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe';

const runSikarugirAction = (
  action: Effect.Effect<SikarugirActionResult, unknown, SikarugirRuntime>
): Effect.Effect<SikarugirActionResult> =>
  action.pipe(
    Effect.provide(SikarugirRuntimeLive),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        const message = formatError(error);
        log(`Error: ${message}`);
        return { success: false, message };
      })
    )
  );

const getSikarugirSetupState = (): Effect.Effect<SikarugirProvisionState> => {
  if (process.platform !== 'darwin') {
    return Effect.succeed({ state: 'unsupported' });
  }
  return Effect.gen(function* () {
    const runtime = yield* SikarugirRuntime;
    const setupState = yield* runtime.setupState;
    if (setupState.state === 'wrapper-missing') {
      return {
        state: 'wrapper-missing' as const,
        message: setupState.readiness.message,
        wrapperPath: setupState.readiness.wrapperPath,
      };
    }
    if (setupState.state === 'ready') {
      return {
        state: 'ready' as const,
        steamAccountIds: setupState.steamAccountIds,
        selectedSteamAccountId: setupState.selectedSteamAccountId,
        steamAccountSelectionRequired: setupState.steamAccountSelectionRequired,
      };
    }
    return { state: setupState.state };
  }).pipe(
    Effect.provide(SikarugirRuntimeLive),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        const message = formatError(error);
        log(`Error: ${message}`);
        return { state: 'wrapper-missing' as const, message };
      })
    )
  );
};

const createSikarugirPrefix = (): Effect.Effect<SikarugirActionResult> =>
  runSikarugirAction(
    Effect.gen(function* () {
      const runtime = yield* SikarugirRuntime;
      const setupState = yield* runtime.setupState;
      if (setupState.state !== 'prefix-missing') {
        return {
          success: false,
          message: `Cannot create the Sikarugir prefix while setup state is ${setupState.state}.`,
        };
      }
      yield* runtime.createPrefix();
      const refresh = yield* Effect.either(runtime.refreshEngineVersion);
      return refresh._tag === 'Left'
        ? {
            success: true,
            message: `Sikarugir prefix created, but the engine version could not be refreshed: ${formatError(refresh.left)}`,
          }
        : { success: true, message: 'Sikarugir prefix created successfully.' };
    })
  );

const installWindowsSteam = (): Effect.Effect<SikarugirActionResult> =>
  runSikarugirAction(
    Effect.gen(function* () {
      const runtime = yield* SikarugirRuntime;
      const setupState = yield* runtime.setupState;
      if (setupState.state !== 'steam-not-installed') {
        return {
          success: false,
          message: `Cannot install Windows Steam while setup state is ${setupState.state}.`,
        };
      }
      const temporaryDirectory = yield* Effect.tryPromise({
        try: () => fs.mkdtemp(join(os.tmpdir(), 'ogi-steam-')),
        catch: (cause) =>
          new FileSystemError({
            message: formatError(cause),
            path: os.tmpdir(),
            cause,
          }),
      });
      const installerPath = join(temporaryDirectory, 'SteamSetup.exe');
      yield* Effect.gen(function* () {
        yield* download(STEAM_INSTALLER_URL, installerPath);
        yield* runtime.installSteam(installerPath);
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise(() =>
            fs.rm(temporaryDirectory, { recursive: true, force: true })
          ).pipe(Effect.ignore)
        )
      );
      return {
        success: true,
        message: 'The Windows Steam setup window was run successfully.',
      };
    })
  );

const launchWindowsSteam = (): Effect.Effect<SikarugirActionResult> =>
  runSikarugirAction(
    Effect.gen(function* () {
      const runtime = yield* SikarugirRuntime;
      const setupState = yield* runtime.setupState;
      if (
        setupState.state !== 'steam-login-required' &&
        setupState.state !== 'ready'
      ) {
        return {
          success: false,
          message: `Cannot launch Windows Steam while setup state is ${setupState.state}.`,
        };
      }
      yield* runtime.launchSteam();
      return { success: true, message: 'Windows Steam launched.' };
    })
  );

const selectSikarugirSteamAccount = (
  accountId: string
): Effect.Effect<SikarugirActionResult> =>
  runSikarugirAction(
    Effect.gen(function* () {
      const runtime = yield* SikarugirRuntime;
      const setupState = yield* runtime.setupState;
      if (
        setupState.state !== 'ready' ||
        !setupState.steamAccountIds.includes(accountId)
      ) {
        return {
          success: false,
          message: `Steam account ${accountId} is not available in the current setup state (${setupState.state}).`,
        };
      }
      const configuration = yield* runtime.readConfiguration;
      yield* runtime.writeConfiguration({
        ...configuration,
        steamAccountId: accountId,
      });
      return { success: true, message: 'Windows Steam account selected.' };
    })
  );

export default function OOBEHandler() {
  return router(
    procedure(ElectronRpc.oobe.downloadTools, () =>
      runEffectBoundary(downloadTools())
    ),
    procedure(ElectronRpc.oobe.getWindowsSupportStatus, () =>
      runEffectBoundary(getWindowsSupportStatus())
    ),
    procedure(ElectronRpc.oobe.startHomebrewInstall, () =>
      runEffectBoundary(startHomebrewInstall())
    ),
    procedure(ElectronRpc.oobe.pollHomebrew, () => pollHomebrew()),
    procedure(ElectronRpc.oobe.installRosetta, () =>
      runEffectBoundary(installRosetta())
    ),
    procedure(ElectronRpc.oobe.installSikarugir, () =>
      runEffectBoundary(installSikarugir())
    ),
    procedure(ElectronRpc.oobe.getSikarugirSetupState, () =>
      runEffectBoundary(getSikarugirSetupState())
    ),
    procedure(ElectronRpc.oobe.createSikarugirPrefix, () =>
      runEffectBoundary(createSikarugirPrefix())
    ),
    procedure(ElectronRpc.oobe.installWindowsSteam, () =>
      runEffectBoundary(installWindowsSteam())
    ),
    procedure(ElectronRpc.oobe.launchWindowsSteam, () =>
      runEffectBoundary(launchWindowsSteam())
    ),
    procedure(
      ElectronRpc.oobe.selectSikarugirSteamAccount,
      (accountId: string) =>
        runEffectBoundary(selectSikarugirSteamAccount(accountId))
    ),
    procedure(ElectronRpc.oobe.setSteamGridDBKey, (key: string) =>
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
