import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Data, Duration, Effect, Exit } from 'effect';
import {
  findTrackedProcessSurvivors,
  type ProcessTreeCleanupError,
  type ProcessTreeTracker,
  readWindowsJobSurvivors,
  spawnTrackedProcess,
  terminateProcessTree,
} from './process-tree';

export class TrackedAttemptSpawnError extends Data.TaggedError(
  'TrackedAttemptSpawnError'
)<{ readonly command: string; readonly cause?: unknown }> {
  override get message() {
    return `Could not start ${this.command}`;
  }
}

export class TrackedAttemptProcessExitError extends Data.TaggedError(
  'TrackedAttemptProcessExitError'
)<{
  readonly command: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  override get message() {
    return `${this.command} exited with status ${this.status} and signal ${this.signal}`;
  }
}

export class TrackedAttemptTrackingError extends Data.TaggedError(
  'TrackedAttemptTrackingError'
)<{ readonly command: string; readonly cause: unknown }> {
  override get message() {
    return `Could not track the process tree for ${this.command}`;
  }
}

export class TrackedAttemptTimeoutError extends Data.TaggedError(
  'TrackedAttemptTimeoutError'
)<{ readonly condition: string; readonly timeout: string }> {
  override get message() {
    return `${this.condition} was not met within ${this.timeout}`;
  }
}

export type TrackedAttemptError =
  | TrackedAttemptSpawnError
  | TrackedAttemptTrackingError;

export type TrackedAttemptProcessError =
  | TrackedAttemptSpawnError
  | TrackedAttemptProcessExitError
  | TrackedAttemptTimeoutError;

export type TrackedAttemptLaunch = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
};

export type TrackedAttemptResult = {
  readonly child: ChildProcess;
  readonly completion:
    | {
        readonly kind: 'process';
        readonly processExit: Exit.Exit<void, TrackedAttemptProcessError>;
      }
    | { readonly kind: 'cancelled' };
  readonly inspectionExit: Exit.Exit<
    readonly number[],
    TrackedAttemptTrackingError
  >;
  readonly cleanupExit: Exit.Exit<void, ProcessTreeCleanupError>;
  readonly unexpectedSurvivors: readonly number[];
};

export type RunTrackedAttemptOptions<R> = {
  readonly launch: TrackedAttemptLaunch;
  readonly cancellation?: Effect.Effect<void, never, R>;
  readonly completionTimeout: Duration.DurationInput;
  readonly completionCondition: string;
  readonly windowsJobResultPath: string;
  readonly survivorSettleDuration?: Duration.DurationInput;
  readonly onStarted?: (child: ChildProcess) => void;
  readonly onStopped?: (result: {
    readonly child: ChildProcess;
    readonly leaked: boolean;
  }) => void;
};

function waitForProcess(
  child: ChildProcess,
  command: string,
  condition: string,
  timeout: Duration.DurationInput
) {
  return Effect.async<void, TrackedAttemptProcessError>((resume) => {
    const onError = (cause: Error) =>
      resume(Effect.fail(new TrackedAttemptSpawnError({ command, cause })));
    const onExit = (status: number | null, signal: NodeJS.Signals | null) =>
      resume(
        status === 0
          ? Effect.void
          : Effect.fail(
              new TrackedAttemptProcessExitError({ command, status, signal })
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
      duration: timeout,
      onTimeout: () =>
        new TrackedAttemptTimeoutError({ condition, timeout: String(timeout) }),
    })
  );
}

export function runTrackedAttempt<R = never>(
  options: RunTrackedAttemptOptions<R>
) {
  const { command, args } = options.launch;
  const commandLine = [command, ...args].join(' ');
  let cleanupAttempted = false;
  return Effect.scoped(
    Effect.gen(function* () {
      const launched = yield* Effect.acquireRelease(
        spawnTrackedProcess(command, args, options.launch.options).pipe(
          Effect.mapError(
            (cause) =>
              new TrackedAttemptTrackingError({ command: commandLine, cause })
          )
        ),
        ({ child, tracker }) =>
          cleanupAttempted
            ? Effect.void
            : terminateProcessTree(child, tracker).pipe(Effect.orDie)
      );
      const { child, tracker } = launched;
      if (child.pid === undefined) {
        return yield* new TrackedAttemptSpawnError({ command: commandLine });
      }
      options.onStarted?.(child);
      const completion = yield* Effect.race(
        Effect.exit(
          waitForProcess(
            child,
            commandLine,
            options.completionCondition,
            options.completionTimeout
          )
        ).pipe(
          Effect.map((processExit) => ({
            kind: 'process' as const,
            processExit,
          }))
        ),
        (options.cancellation ?? Effect.never).pipe(
          Effect.as({ kind: 'cancelled' as const })
        )
      );
      if (completion.kind === 'process' && options.survivorSettleDuration) {
        yield* Effect.sleep(options.survivorSettleDuration);
      }
      const inspectionExit =
        completion.kind === 'process'
          ? yield* Effect.exit(
              process.platform === 'win32'
                ? Effect.try({
                    try: () =>
                      readWindowsJobSurvivors(options.windowsJobResultPath),
                    catch: (cause) =>
                      new TrackedAttemptTrackingError({
                        command: commandLine,
                        cause,
                      }),
                  })
                : findTrackedProcessSurvivors(tracker, [child.pid]).pipe(
                    Effect.mapError(
                      (cause) =>
                        new TrackedAttemptTrackingError({
                          command: commandLine,
                          cause,
                        })
                    )
                  )
            )
          : Exit.succeed([] as readonly number[]);
      const unexpectedSurvivors = Exit.isSuccess(inspectionExit)
        ? inspectionExit.value
        : [];
      cleanupAttempted = true;
      const cleanupExit = yield* Effect.exit(
        terminateProcessTree(child, tracker).pipe(Effect.uninterruptible)
      );
      options.onStopped?.({
        child,
        leaked: unexpectedSurvivors.length > 0 || Exit.isFailure(cleanupExit),
      });
      return {
        child,
        completion,
        inspectionExit,
        cleanupExit,
        unexpectedSurvivors,
      } satisfies TrackedAttemptResult;
    })
  );
}
