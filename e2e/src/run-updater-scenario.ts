import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Data, Effect, Exit } from 'effect';
import { terminateProcessTree } from './process-tree';
import {
  makeRunEventWriter,
  replayRunEventLog,
  type TerminalOutcome,
} from './run-events';
import {
  createUpdaterScenarioSandbox,
  FixtureServiceError,
  getUpdaterScenarioLaunch,
  startFixtureService,
  writeUpdaterRunDescriptor,
} from './updater-scenario';

class UpdaterScenarioProcessError extends Data.TaggedError(
  'UpdaterScenarioProcessError'
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

class UpdaterScenarioTimeoutError extends Data.TaggedError(
  'UpdaterScenarioTimeoutError'
)<{ readonly condition: string; readonly timeout: string }> {
  override get message() {
    return `${this.condition} was not met within ${this.timeout}`;
  }
}

function waitForProcess(child: ChildProcess, command: string) {
  return Effect.async<void, UpdaterScenarioProcessError>((resume) => {
    const onError = (cause: Error) =>
      resume(
        Effect.fail(
          new UpdaterScenarioProcessError({
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
              new UpdaterScenarioProcessError({ command, status, signal })
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
        new UpdaterScenarioTimeoutError({
          condition: 'deterministic Updater Scenario completion',
          timeout: '2 minutes',
        }),
    })
  );
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const e2eDirectory = resolve(currentDirectory, '..');
const runId = randomUUID();
const layout = createUpdaterScenarioSandbox(runId);
const fixture = await startFixtureService(layout.fixtureStateDirectory);
const descriptor = writeUpdaterRunDescriptor(layout, fixture.baseUrl);
let writeEvent = makeRunEventWriter(descriptor.eventLogPath, runId);
writeEvent({ type: 'run.started', payload: { platform: process.platform } });
writeEvent({
  type: 'scenario.started',
  payload: { scenarioId: descriptor.scenario, kind: 'Updater Scenario' },
});
writeEvent({
  type: 'attempt.started',
  payload: { scenarioId: descriptor.scenario, attempt: 1 },
});
writeEvent({ type: 'fixture.started', payload: { port: fixture.port } });

const scenario = Effect.scoped(
  Effect.gen(function* () {
    const { command, args, detached } = getUpdaterScenarioLaunch(
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
          new UpdaterScenarioProcessError({
            command: commandLine,
            status: null,
            signal: null,
            cause,
          }),
      }),
      (processHandle) => terminateProcessTree(processHandle).pipe(Effect.orDie)
    );
    if (child.pid === undefined) {
      return yield* new UpdaterScenarioProcessError({
        command: commandLine,
        status: null,
        signal: null,
      });
    }
    writeEvent({
      type: 'process.started',
      payload: { pid: child.pid, name: 'WebdriverIO Updater Scenario' },
    });
    const processExit = yield* Effect.exit(waitForProcess(child, commandLine));
    const cleanupExit = yield* Effect.exit(terminateProcessTree(child));
    writeEvent = makeRunEventWriter(
      descriptor.eventLogPath,
      runId,
      replayRunEventLog(descriptor.eventLogPath).lastSequence
    );
    writeEvent({
      type: 'process.stopped',
      payload: { pid: child.pid, leaked: Exit.isFailure(cleanupExit) },
    });
    if (Exit.isFailure(cleanupExit)) {
      return yield* Effect.failCause(cleanupExit.cause);
    }
    if (Exit.isFailure(processExit)) {
      return yield* Effect.failCause(processExit.cause);
    }
  })
);

const program = Effect.gen(function* () {
  const scenarioExit = yield* Effect.exit(scenario);
  const fixtureCloseExit = yield* Effect.exit(
    Effect.tryPromise({
      try: () => fixture.close(),
      catch: (cause) =>
        new FixtureServiceError({
          detail: 'Fixture Service failed to stop',
          cause,
        }),
    })
  );
  const failureCause = Exit.isFailure(scenarioExit)
    ? scenarioExit.cause
    : Exit.isFailure(fixtureCloseExit)
      ? fixtureCloseExit.cause
      : undefined;

  writeEvent = makeRunEventWriter(
    descriptor.eventLogPath,
    runId,
    replayRunEventLog(descriptor.eventLogPath).lastSequence
  );
  const requestLines = readFileSync(fixture.requestLogPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  for (const line of requestLines) {
    const request = JSON.parse(line) as {
      method: string;
      path: string;
      status: number;
    };
    writeEvent({
      type: 'fixture.request',
      payload: {
        method: request.method,
        path: request.path,
        status: request.status,
      },
    });
  }
  writeEvent({
    type: 'fixture.stopped',
    payload: { requests: requestLines.length },
  });

  if (existsSync(descriptor.nativeDialogLogPath)) {
    for (const line of readFileSync(descriptor.nativeDialogLogPath, 'utf8')
      .split(/\r?\n/)
      .filter((value) => value.trim().length > 0)) {
      const request = JSON.parse(line) as {
        action: string;
        kind: string;
        response: number;
      };
      writeEvent({
        type: 'native-dialog.request',
        payload: {
          action: request.action,
          kind: request.kind,
          response: request.response,
        },
      });
    }
  }

  const failureDetail = failureCause
    ? Cause.pretty(failureCause as Cause.Cause<unknown>)
    : '';
  const outcome: TerminalOutcome = failureCause
    ? /ProcessTreeCleanupError|FixtureServiceError/.test(failureDetail)
      ? 'Infrastructure Failed'
      : 'Failed'
    : 'Passed';
  const artifacts = [
    [
      'updater-main-log',
      join(descriptor.artifactDirectory, 'updater-main.log'),
    ],
    [
      'updater-renderer-log',
      join(descriptor.artifactDirectory, 'updater-renderer.log'),
    ],
    ['fixture-requests', fixture.requestLogPath],
    ['native-dialog-requests', descriptor.nativeDialogLogPath],
    ['run-descriptor', descriptor.descriptorPath],
  ] as const;
  const recordedArtifacts =
    replayRunEventLog(descriptor.eventLogPath).scenarios[descriptor.scenario]
      ?.artifacts ?? [];
  for (const [artifactType, path] of artifacts) {
    const artifactPath = relative(descriptor.sandboxDirectory, path);
    if (existsSync(path) && !recordedArtifacts.includes(artifactPath)) {
      writeEvent({
        type: 'artifact.created',
        payload: { artifactType, path: artifactPath },
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
  if (failureCause) {
    console.error(failureDetail);
    return yield* Effect.failCause(failureCause as Cause.Cause<unknown>);
  }
});

const exit = await Effect.runPromiseExit(program);
process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
