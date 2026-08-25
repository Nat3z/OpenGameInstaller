import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { SikarugirError } from '@ogi-sdk/errors';
import { Effect } from 'effect';

export type LauncherMode = 'modern' | 'legacy';

interface LauncherOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SikarugirLauncher {
  /** Resolve which command surface the launcher exposes, via its `--help`. */
  readonly probeCapabilities: Effect.Effect<LauncherMode, SikarugirError>;
  readonly createPrefix: (
    noRegistries?: boolean
  ) => Effect.Effect<void, SikarugirError>;
  readonly run: (
    executablePath: string,
    flags?: readonly string[]
  ) => Effect.Effect<void, SikarugirError>;
  readonly runAndWait: (
    executablePath: string,
    flags?: readonly string[]
  ) => Effect.Effect<void, SikarugirError>;
  /**
   * Like {@link runAndWait}, but invokes `onSpawn` as soon as the launcher
   * process starts so a caller can report "launched" before the game exits.
   */
  readonly runAndWaitWithSpawnSignal: (
    executablePath: string,
    flags: readonly string[],
    onSpawn: () => void
  ) => Effect.Effect<void, SikarugirError>;
  readonly runStartExecutable: (
    executablePath: string,
    flags?: readonly string[]
  ) => Effect.Effect<void, SikarugirError>;
  readonly winetricks: (
    verb: string,
    force?: boolean
  ) => Effect.Effect<void, SikarugirError>;
  readonly quit: Effect.Effect<void, SikarugirError>;
}

const launcherPathEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
};
const capabilityCache = new Map<string, LauncherMode>();

const runLauncher = (
  launcherPath: string,
  args: readonly string[],
  step: string,
  onSpawn?: () => void
): Effect.Effect<LauncherOutput, SikarugirError> =>
  Effect.async<LauncherOutput, SikarugirError>((resume) => {
    const child = spawn(launcherPath, [...args], {
      cwd: path.dirname(launcherPath),
      env: launcherPathEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (onSpawn) child.once('spawn', onSpawn);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString()}`.slice(-65_536);
    const settle = (
      result: Effect.Effect<LauncherOutput, SikarugirError>
    ): void => {
      if (settled) return;
      settled = true;
      resume(result);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (cause) =>
      settle(
        Effect.fail(
          new SikarugirError({
            message: `Could not start the Sikarugir launcher: ${cause.message}`,
            step,
            cause,
          })
        )
      )
    );
    child.once('close', (exitCode) =>
      settle(Effect.succeed({ exitCode, stdout, stderr }))
    );
    return Effect.sync(() => child.kill());
  });

const requireSuccessfulExit = (
  launcherPath: string,
  args: readonly string[],
  step: string,
  onSpawn?: () => void
): Effect.Effect<void, SikarugirError> =>
  runLauncher(launcherPath, args, step, onSpawn).pipe(
    Effect.flatMap((output) =>
      output.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new SikarugirError({
              message: `Sikarugir launcher exited with code ${String(output.exitCode)}${
                output.stderr.trim() ? `: ${output.stderr.trim()}` : ''
              }`,
              step,
            })
          )
    )
  );

const launchDetached = (
  launcherPath: string,
  args: readonly string[],
  step: string
): Effect.Effect<void, SikarugirError> =>
  Effect.async<void, SikarugirError>((resume) => {
    const child = spawn(launcherPath, [...args], {
      cwd: path.dirname(launcherPath),
      detached: true,
      env: launcherPathEnvironment,
      stdio: 'ignore',
    });
    let settled = false;
    const settle = (result: Effect.Effect<void, SikarugirError>): void => {
      if (settled) return;
      settled = true;
      resume(result);
    };
    child.once('error', (cause) =>
      settle(
        Effect.fail(
          new SikarugirError({
            message: `Could not start the Sikarugir launcher: ${cause.message}`,
            step,
            cause,
          })
        )
      )
    );
    child.once('spawn', () => {
      child.unref();
      settle(Effect.void);
    });
    return Effect.sync(() => {
      if (!settled) child.kill();
    });
  });

const detectLauncherMode = (
  launcherPath: string
): Effect.Effect<LauncherMode, SikarugirError> => {
  const cached = capabilityCache.get(launcherPath);
  if (cached) return Effect.succeed(cached);
  return runLauncher(launcherPath, ['--help'], 'capability-check').pipe(
    Effect.flatMap(({ stdout, stderr }) => {
      const help = `${stdout}\n${stderr}`;
      const modern = ['create-prefix', 'run', 'winetricks', 'quit'].every(
        (subcommand) => help.includes(subcommand)
      );
      const legacy = [
        'WSS-wineprefixcreate',
        'WSS-installer',
        'WSS-winetricks',
        'WSS-wineserverkill',
      ].every((subcommand) => help.includes(subcommand));
      const mode: LauncherMode | undefined = modern
        ? 'modern'
        : legacy
          ? 'legacy'
          : undefined;
      if (!mode) {
        return Effect.fail(
          new SikarugirError({
            message:
              'The wrapper launcher does not expose the expected modern or legacy commands',
            step: 'capability-check',
          })
        );
      }
      capabilityCache.set(launcherPath, mode);
      return Effect.succeed(mode);
    })
  );
};

const withMode = (
  launcherPath: string,
  command: (mode: LauncherMode) => Effect.Effect<void, SikarugirError>
): Effect.Effect<void, SikarugirError> =>
  detectLauncherMode(launcherPath).pipe(Effect.flatMap(command));

export const makeSikarugirLauncher = (
  launcherPath: string
): SikarugirLauncher => ({
  probeCapabilities: detectLauncherMode(launcherPath),
  createPrefix: (noRegistries = false) =>
    withMode(launcherPath, (mode) =>
      requireSuccessfulExit(
        launcherPath,
        mode === 'modern'
          ? ['create-prefix', ...(noRegistries ? ['--no-regs'] : [])]
          : [
              noRegistries
                ? 'WSS-wineprefixcreatenoregs'
                : 'WSS-wineprefixcreate',
            ],
        'create-prefix'
      )
    ),
  run: (executablePath, flags = []) =>
    withMode(launcherPath, (mode) =>
      launchDetached(
        launcherPath,
        mode === 'modern'
          ? ['run', executablePath, ...flags]
          : ['WSS-installer', executablePath, ...flags],
        'run'
      )
    ),
  runAndWait: (executablePath, flags = []) =>
    withMode(launcherPath, (mode) =>
      requireSuccessfulExit(
        launcherPath,
        mode === 'modern'
          ? ['run', executablePath, ...flags]
          : ['WSS-installer', executablePath, ...flags],
        'run'
      )
    ),
  runAndWaitWithSpawnSignal: (executablePath, flags, onSpawn) =>
    withMode(launcherPath, (mode) =>
      requireSuccessfulExit(
        launcherPath,
        mode === 'modern'
          ? ['run', executablePath, ...flags]
          : ['WSS-installer', executablePath, ...flags],
        'run',
        onSpawn
      )
    ),
  runStartExecutable: (executablePath, flags = []) =>
    withMode(launcherPath, (mode) =>
      requireSuccessfulExit(
        launcherPath,
        mode === 'modern'
          ? ['run', '--start-exe', executablePath, ...flags]
          : ['WSS-installer', executablePath, ...flags],
        'run-installer'
      )
    ),
  winetricks: (verb, force = false) =>
    withMode(launcherPath, (mode) =>
      requireSuccessfulExit(
        launcherPath,
        mode === 'modern'
          ? ['winetricks', ...(force ? ['--force'] : []), verb]
          : ['WSS-winetricks', ...(force ? ['--force'] : []), verb],
        `winetricks:${verb}`
      )
    ),
  quit: withMode(launcherPath, (mode) =>
    requireSuccessfulExit(
      launcherPath,
      [mode === 'modern' ? 'quit' : 'WSS-wineserverkill'],
      'quit'
    )
  ),
});
