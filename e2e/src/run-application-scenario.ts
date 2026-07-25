import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Data, Effect, Exit } from 'effect';
import {
  createApplicationScenarioSandbox,
  ensureApplicationFailureEvidence,
  getApplicationScenarioLaunch,
  parseApplicationScenarioMode,
  validateApplicationScenarioProcessOutcome,
} from './application-scenario';
import { terminateProcessTree } from './process-tree';
import {
  makeRunEventWriter,
  replayRunEventLog,
  type TerminalOutcome,
} from './run-events';

class ApplicationScenarioProcessError extends Data.TaggedError(
  'ApplicationScenarioProcessError'
)<{
  readonly command: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cause?: unknown;
}> {
  override get message() {
    return `${this.command} exited with status ${this.status} and signal ${this.signal}`;
  }
}

class ApplicationScenarioTimeoutError extends Data.TaggedError(
  'ApplicationScenarioTimeoutError'
)<{ readonly condition: string; readonly timeout: string }> {
  override get message() {
    return `${this.condition} was not met within ${this.timeout}`;
  }
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const e2eDirectory = resolve(currentDirectory, '..');
const runId = randomUUID();
const mode = parseApplicationScenarioMode(process.argv.slice(2));
const descriptor = createApplicationScenarioSandbox(runId, mode);
const observerAnnouncementPath = process.env.OGI_OBSERVER_ANNOUNCEMENT;
if (observerAnnouncementPath) {
  writeFileSync(
    observerAnnouncementPath,
    JSON.stringify({
      runId,
      sandboxDirectory: descriptor.sandboxDirectory,
      eventLogPath: descriptor.eventLogPath,
    })
  );
}
const mainLogPath = join(descriptor.artifactDirectory, 'application-main.log');
const rendererLogPath = join(
  descriptor.artifactDirectory,
  'application-renderer.log'
);
writeFileSync(mainLogPath, '');
writeFileSync(rendererLogPath, '');
let writeEvent = makeRunEventWriter(descriptor.eventLogPath, runId);
writeEvent({ type: 'run.started', payload: { platform: process.platform } });
writeEvent({
  type: 'scenario.started',
  payload: {
    scenarioId: descriptor.scenario,
    kind: 'Application Scenario',
  },
});
writeEvent({
  type: 'attempt.started',
  payload: { scenarioId: descriptor.scenario, attempt: 1 },
});

let cancellationRequested = false;
let requestCancellation!: () => void;
const cancellation = new Promise<void>((resolveCancellation) => {
  requestCancellation = resolveCancellation;
});
const cancel = () => {
  cancellationRequested = true;
  requestCancellation();
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const observerCancellationPath = process.env.OGI_OBSERVER_CANCELLATION;
const cancellationPoll = observerCancellationPath
  ? setInterval(() => {
      if (existsSync(observerCancellationPath)) cancel();
    }, 100)
  : null;

function waitForCancellation() {
  return Effect.promise(() => cancellation);
}

function waitForProcess(child: ChildProcess, command: string) {
  return Effect.async<void, ApplicationScenarioProcessError>((resume) => {
    const onError = (cause: Error) =>
      resume(
        Effect.fail(
          new ApplicationScenarioProcessError({
            command,
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
              new ApplicationScenarioProcessError({
                command,
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
      duration: '2 minutes',
      onTimeout: () =>
        new ApplicationScenarioTimeoutError({
          condition: 'observable Application Scenario completion',
          timeout: '2 minutes',
        }),
    })
  );
}

const scenario = Effect.scoped(
  Effect.gen(function* () {
    const { command, args, detached } = getApplicationScenarioLaunch(
      process.platform
    );
    const commandLine = [command, ...args].join(' ');
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(command, args, {
            cwd: e2eDirectory,
            detached,
            env: {
              ...process.env,
              OGI_RUN_DESCRIPTOR: descriptor.descriptorPath,
            },
            stdio: 'inherit',
          }),
        catch: (cause) =>
          new ApplicationScenarioProcessError({
            command: commandLine,
            status: null,
            signal: null,
            cause,
          }),
      }),
      (processHandle) => terminateProcessTree(processHandle).pipe(Effect.orDie)
    );
    if (child.pid === undefined) {
      return yield* new ApplicationScenarioProcessError({
        command: commandLine,
        status: null,
        signal: null,
      });
    }
    writeEvent({
      type: 'process.started',
      payload: { pid: child.pid, name: 'WebdriverIO Application Scenario' },
    });
    const completion = yield* Effect.race(
      Effect.exit(waitForProcess(child, commandLine)).pipe(
        Effect.map((processExit) => ({ kind: 'process' as const, processExit }))
      ),
      waitForCancellation().pipe(Effect.as({ kind: 'cancelled' as const }))
    );
    const cleanupExit = yield* Effect.exit(terminateProcessTree(child));
    writeEvent = makeRunEventWriter(
      descriptor.eventLogPath,
      runId,
      replayRunEventLog(descriptor.eventLogPath).lastSequence
    );
    writeEvent({
      type: 'process.stopped',
      payload: {
        pid: child.pid,
        leaked: Exit.isFailure(cleanupExit),
      },
    });
    if (Exit.isFailure(cleanupExit)) {
      return yield* Effect.failCause(cleanupExit.cause);
    }
    if (completion.kind === 'cancelled') return true;
    if (descriptor.mode === 'assertion-failure') {
      yield* Effect.try({
        try: () => {
          validateApplicationScenarioProcessOutcome(
            descriptor.mode,
            Exit.isFailure(completion.processExit)
          );
        },
        catch: (cause) => cause,
      });
    }
    if (Exit.isFailure(completion.processExit)) {
      return yield* Effect.failCause(completion.processExit.cause);
    }
    return false;
  })
);

const program = Effect.gen(function* () {
  const scenarioExit = yield* Effect.exit(scenario);
  if (Exit.isFailure(scenarioExit)) {
    yield* Effect.tryPromise({
      try: () =>
        ensureApplicationFailureEvidence(
          descriptor,
          Cause.pretty(scenarioExit.cause)
        ),
      catch: (cause) => cause,
    });
  }
  const outcome: TerminalOutcome = Exit.isSuccess(scenarioExit)
    ? scenarioExit.value || cancellationRequested
      ? 'Cancelled'
      : 'Passed'
    : Cause.pretty(scenarioExit.cause).includes('ProcessTreeCleanupError')
      ? 'Infrastructure Failed'
      : 'Failed';
  writeEvent = makeRunEventWriter(
    descriptor.eventLogPath,
    runId,
    replayRunEventLog(descriptor.eventLogPath).lastSequence
  );
  const artifacts = [
    ['main-log', mainLogPath],
    ['renderer-log', rendererLogPath],
    ['run-descriptor', descriptor.descriptorPath],
    ...(Exit.isFailure(scenarioExit)
      ? ([
          ['screenshot', join(descriptor.artifactDirectory, 'failure.png')],
        ] as const)
      : []),
  ] as const;
  const recordedArtifacts =
    replayRunEventLog(descriptor.eventLogPath).scenarios[descriptor.scenario]
      ?.artifacts ?? [];
  for (const [artifactType, path] of artifacts) {
    const artifactPath = relative(descriptor.sandboxDirectory, path);
    if (existsSync(path) && !recordedArtifacts.includes(artifactPath)) {
      writeEvent({
        type: 'artifact.created',
        payload: {
          artifactType,
          path: artifactPath,
        },
      });
    }
  }
  writeEvent({
    type: 'attempt.completed',
    payload: { attempt: 1, outcome },
  });
  writeEvent({
    type: 'scenario.completed',
    payload: { scenarioId: descriptor.scenario, outcome },
  });
  writeEvent({ type: 'run.completed', payload: { outcome } });
  const replay = replayRunEventLog(descriptor.eventLogPath);
  writeFileSync(
    join(descriptor.sandboxDirectory, 'summary.json'),
    JSON.stringify(replay, null, 2)
  );
  console.log(`Run Event Log: ${descriptor.eventLogPath}`);
  console.log(`Scenario Sandbox: ${descriptor.sandboxDirectory}`);
  if (Exit.isFailure(scenarioExit)) {
    console.error(Cause.pretty(scenarioExit.cause));
    return yield* Effect.failCause(scenarioExit.cause);
  }
});

const exit = await Effect.runPromiseExit(program);
if (cancellationPoll) clearInterval(cancellationPoll);
process.off('SIGINT', cancel);
process.off('SIGTERM', cancel);
process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
