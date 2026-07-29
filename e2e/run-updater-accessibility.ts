import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Data, Effect, Exit } from 'effect';
import { spawnTrackedProcess, terminateProcessTree } from './src/process-tree';
import type { UpdaterAccessibilityState } from './updater-accessibility-states';

class UpdaterAccessibilityProcessError extends Data.TaggedError(
  'UpdaterAccessibilityProcessError'
)<{
  readonly command: string;
  readonly status: number | null;
  readonly signal: string | null;
  readonly cause?: unknown;
}> {}

class UpdaterAccessibilityTimeoutError extends Data.TaggedError(
  'UpdaterAccessibilityTimeoutError'
)<{
  readonly state: string;
  readonly timeout: string;
}> {}

class AxeSourceError extends Data.TaggedError('AxeSourceError')<{
  readonly source: string;
  readonly cause: unknown;
}> {}

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const axeSource = resolve(
  currentDirectory,
  '../node_modules/axe-core/axe.min.js'
);

const verifyAxeSource = Effect.try({
  try: () => accessSync(axeSource, constants.R_OK),
  catch: (cause) => new AxeSourceError({ source: axeSource, cause }),
});

function runState(state: UpdaterAccessibilityState) {
  return Effect.scoped(
    Effect.gen(function* () {
      const sandboxDirectory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), `ogi-updater-${state}-`))),
        (directory) =>
          Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
      );
      const command = process.platform === 'linux' ? 'xvfb-run' : 'bunx';
      const args =
        process.platform === 'linux'
          ? ['-a', 'bunx', 'wdio', 'run', './updater-wdio.conf.ts']
          : ['wdio', 'run', './updater-wdio.conf.ts'];
      const { child, tracker } = yield* Effect.acquireRelease(
        spawnTrackedProcess(command, args, {
          cwd: currentDirectory,
          detached: process.platform !== 'win32',
          env: {
            ...process.env,
            OGI_AXE_SOURCE: axeSource,
            OGI_SCENARIO_SANDBOX: sandboxDirectory,
            OGI_UPDATER_ACCESSIBILITY_STATE: state,
          },
          stdio: 'inherit',
        }).pipe(
          Effect.mapError(
            (cause) =>
              new UpdaterAccessibilityProcessError({
                command: [command, ...args].join(' '),
                status: null,
                signal: null,
                cause,
              })
          )
        ),
        ({ child: processHandle, tracker: processTracker }) =>
          terminateProcessTree(processHandle, processTracker).pipe(Effect.orDie)
      );

      yield* Effect.async<void, UpdaterAccessibilityProcessError>((resume) => {
        const onError = (cause: Error) =>
          resume(
            Effect.fail(
              new UpdaterAccessibilityProcessError({
                command: [command, ...args].join(' '),
                status: null,
                signal: null,
                cause,
              })
            )
          );
        const onExit = (status: number | null, signal: NodeJS.Signals | null) =>
          resume(
            status === 0
              ? Effect.void
              : Effect.fail(
                  new UpdaterAccessibilityProcessError({
                    command: [command, ...args].join(' '),
                    status,
                    signal,
                  })
                )
          );
        if (child.exitCode !== null || child.signalCode !== null) {
          onExit(child.exitCode, child.signalCode);
          return;
        }
        child.once('error', onError);
        child.once('exit', onExit);
        return Effect.sync(() => {
          child.off('error', onError);
          child.off('exit', onExit);
        });
      }).pipe(
        Effect.timeoutFail({
          duration: '3 minutes',
          onTimeout: () =>
            new UpdaterAccessibilityTimeoutError({
              state,
              timeout: '3 minutes',
            }),
        })
      );
    })
  );
}

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* verifyAxeSource;
    // All deterministic updater states are exercised in one Electron session.
    // Starting four ChromeDriver sessions made their identical shutdown cost
    // dominate the PR budget without adding state isolation value.
    yield* runState('selection');
  })
);

const exit = await Effect.runPromiseExit(program);
Exit.match(exit, {
  onFailure: (cause) => {
    console.error(Cause.pretty(cause));
    process.exitCode = 1;
  },
  onSuccess: () => {
    process.exitCode = 0;
  },
});
