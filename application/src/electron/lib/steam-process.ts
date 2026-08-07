import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import {
  formatError,
  SteamProcessError,
  SteamProcessTimeoutError,
  SteamRunningError,
} from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { Cause, Context, Effect, Layer } from 'effect';

const logger = createLogger(LOGGER_PREFIXES.electron);

export type SteamProcessFailure = SteamProcessError | SteamProcessTimeoutError;
export type SteamInstallationKind = 'native' | 'flatpak';

export const getSteamInstallationKind = (
  root: string
): SteamInstallationKind =>
  root.includes('/.var/app/com.valvesoftware.Steam/') ? 'flatpak' : 'native';

export const runWithSteamLifecycle = <A, E>(params: {
  allowSteamShutdown: boolean;
  status: Effect.Effect<boolean, SteamProcessFailure>;
  shutdownAndWait: Effect.Effect<void, SteamProcessFailure>;
  startAndWait: Effect.Effect<void, SteamProcessFailure>;
  operation: Effect.Effect<A, E>;
}): Effect.Effect<
  { value: A; restartWarning?: string },
  E | SteamRunningError | SteamProcessFailure
> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const wasRunning = yield* restore(params.status);
      if (wasRunning && !params.allowSteamShutdown) {
        return yield* Effect.fail(
          new SteamRunningError({
            message:
              'Steam must close briefly before OpenGameInstaller can update shortcuts.vdf',
          })
        );
      }
      if (!wasRunning) {
        return {
          value: yield* restore(params.operation),
          restartWarning: undefined,
        };
      }

      const result = yield* Effect.exit(
        params.shutdownAndWait.pipe(Effect.andThen(restore(params.operation)))
      );
      const restart = yield* Effect.exit(params.startAndWait);
      const restartFailure =
        restart._tag === 'Failure'
          ? formatError(Cause.squash(restart.cause))
          : undefined;

      if (result._tag === 'Failure') {
        if (restartFailure) {
          yield* logger.error(
            `[steam] The Steam shortcut lifecycle failed and Steam could not be restarted: ${restartFailure}`
          );
        }
        return yield* Effect.failCause(result.cause);
      }

      return {
        value: result.value,
        restartWarning: restartFailure
          ? `The Steam shortcut was updated, but Steam could not be restarted: ${restartFailure}`
          : undefined,
      };
    })
  );

const isSteamProcessName = (value: string): boolean =>
  value === 'steam' || value === 'steam.sh';

export function findSteamProcessIds(
  platform: NodeJS.Platform = process.platform,
  procRoot = '/proc',
  installation?: SteamInstallationKind
): Effect.Effect<number[], SteamProcessError> {
  return Effect.try({
    try: () => {
      if (platform !== 'linux') {
        throw new SteamProcessError({
          message: `Steam process management is not supported on ${platform}`,
          operation: 'status',
        });
      }
      return fs.readdirSync(procRoot).flatMap((entry) => {
        if (!/^\d+$/.test(entry)) return [];
        try {
          const command = fs
            .readFileSync(`${procRoot}/${entry}/comm`, 'utf8')
            .trim()
            .toLowerCase();
          if (!isSteamProcessName(command)) return [];
          if (!installation) return [Number(entry)];
          const processMetadata = [
            `${procRoot}/${entry}/cmdline`,
            `${procRoot}/${entry}/cgroup`,
          ]
            .flatMap((metadataPath) =>
              fs.existsSync(metadataPath)
                ? [fs.readFileSync(metadataPath, 'utf8').toLowerCase()]
                : []
            )
            .join('\n');
          const isFlatpak = processMetadata.includes('com.valvesoftware.steam');
          return (installation === 'flatpak') === isFlatpak
            ? [Number(entry)]
            : [];
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES') {
            return [];
          }
          throw cause;
        }
      });
    },
    catch: (cause) =>
      cause instanceof SteamProcessError
        ? cause
        : new SteamProcessError({
            message: 'Could not inspect the Steam process state',
            operation: 'status',
            cause,
          }),
  });
}

export function detectSteamRunning(
  platform: NodeJS.Platform = process.platform,
  procRoot = '/proc',
  installation?: SteamInstallationKind
): Effect.Effect<boolean, SteamProcessError> {
  return findSteamProcessIds(platform, procRoot, installation).pipe(
    Effect.map((processIds) => processIds.length > 0)
  );
}

export const getSteamCommandCandidates = (
  args: string[] = [],
  installation?: SteamInstallationKind
): { command: string; args: string[] }[] => {
  const native = { command: 'steam', args };
  const flatpak = {
    command: 'flatpak',
    args: ['run', 'com.valvesoftware.Steam', ...args],
  };
  if (installation === 'native') return [native];
  if (installation === 'flatpak') return [flatpak];
  return [native, flatpak];
};

const runCommand = (
  command: string,
  args: string[],
  operation: SteamProcessError['operation']
): Effect.Effect<void, SteamProcessError> =>
  Effect.async((resume) => {
    execFile(command, args, (cause) => {
      if (cause) {
        resume(
          Effect.fail(
            new SteamProcessError({
              message: `Failed to run ${command} ${args.join(' ')}`,
              operation,
              cause,
            })
          )
        );
      } else {
        resume(Effect.void);
      }
    });
  });

const runSteamCommand = (
  args: string[],
  operation: SteamProcessError['operation'],
  installation: SteamInstallationKind
): Effect.Effect<void, SteamProcessError> => {
  const [candidate] = getSteamCommandCandidates(args, installation);
  return runCommand(candidate.command, candidate.args, operation);
};

const startDetached = (
  command: string,
  args: string[]
): Effect.Effect<void, SteamProcessError> =>
  Effect.async((resume) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    let settled = false;
    const settle = (effect: Effect.Effect<void, SteamProcessError>): void => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    child.once('error', (cause) =>
      settle(
        Effect.fail(
          new SteamProcessError({
            message: `Failed to start ${command}`,
            operation: 'start',
            cause,
          })
        )
      )
    );
    child.once('spawn', () => {
      child.unref();
      settle(Effect.void);
    });
  });

const startSteam = (
  installation: SteamInstallationKind
): Effect.Effect<void, SteamProcessError> => {
  const [candidate] = getSteamCommandCandidates([], installation);
  return startDetached(candidate.command, candidate.args);
};

const waitForState = (
  expected: 'running' | 'stopped',
  status: Effect.Effect<boolean, SteamProcessError>,
  timeoutMs: number,
  intervalMs = 250
): Effect.Effect<void, SteamProcessFailure> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const running = yield* status;
      if (running === (expected === 'running')) return;
      yield* Effect.sleep(`${intervalMs} millis`);
    }
    return yield* Effect.fail(
      new SteamProcessTimeoutError({
        message: `Timed out waiting for Steam to become ${expected}`,
        expected,
        timeoutMs,
      })
    );
  });

export class SteamProcess extends Context.Tag('SteamProcess')<
  SteamProcess,
  {
    readonly status: (
      installation: SteamInstallationKind
    ) => Effect.Effect<boolean, SteamProcessError>;
    readonly shutdownAndWait: (
      installation: SteamInstallationKind
    ) => Effect.Effect<void, SteamProcessFailure>;
    readonly startAndWait: (
      installation: SteamInstallationKind
    ) => Effect.Effect<void, SteamProcessFailure>;
  }
>() {}

const terminateSteamProcesses = (
  installation: SteamInstallationKind
): Effect.Effect<void, SteamProcessError> =>
  Effect.gen(function* () {
    const processIds = yield* findSteamProcessIds(
      process.platform,
      '/proc',
      installation
    );
    yield* Effect.try({
      try: () => {
        for (const processId of processIds) {
          try {
            process.kill(processId, 'SIGTERM');
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
          }
        }
      },
      catch: (cause) =>
        new SteamProcessError({
          message: `Could not terminate ${installation} Steam processes`,
          operation: 'shutdown',
          cause,
        }),
    });
  });

export const SteamProcessLive: Layer.Layer<SteamProcess> = Layer.suspend(() => {
  const status = (installation: SteamInstallationKind) =>
    detectSteamRunning(process.platform, '/proc', installation);
  const shutdownAndWait = (installation: SteamInstallationKind) =>
    Effect.gen(function* () {
      const installationStatus = status(installation);
      if (!(yield* installationStatus)) return;
      yield* runSteamCommand(['-shutdown'], 'shutdown', installation).pipe(
        Effect.catchAll((error) =>
          logger.warn(
            `[steam] Graceful shutdown command failed: ${error.message}`
          )
        )
      );
      const graceful = yield* Effect.either(
        waitForState('stopped', installationStatus, 10_000)
      );
      if (graceful._tag === 'Right') return;
      yield* terminateSteamProcesses(installation).pipe(
        Effect.catchAll((error) =>
          logger.warn(`[steam] Fallback shutdown failed: ${error.message}`)
        )
      );
      yield* waitForState('stopped', installationStatus, 5_000);
    });
  const startAndWait = (installation: SteamInstallationKind) =>
    Effect.gen(function* () {
      const installationStatus = status(installation);
      if (yield* installationStatus) return;
      yield* startSteam(installation);
      yield* waitForState('running', installationStatus, 15_000);
    });
  return Layer.succeed(SteamProcess, { status, shutdownAndWait, startAndWait });
});
