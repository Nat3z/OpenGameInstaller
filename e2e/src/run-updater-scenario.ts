import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Exit, Option } from 'effect';
import {
  type ExecutionVideoRecording,
  startExecutionVideo,
  stopExecutionVideo,
} from './execution-video';
import {
  makeRunEventWriter,
  readRunEvents,
  renderRunHtmlReport,
  replayRunEventLog,
  type TerminalOutcome,
} from './run-events';
import {
  type AttemptOutcome,
  applyRunRetention,
  classifyAttemptProcessFailure,
  classifyRunOutcome,
  finalizeRunRetention,
  getDefaultRunRoot,
  getRequiredCheckResult,
  hasExpectedAssertionExitConfirmation,
  validateScenarioSourceDispositions,
} from './run-reliability';
import { runTrackedAttempt } from './run-tracked-attempt';
import {
  createUpdaterScenarioSandbox,
  FixtureServiceError,
  getUpdaterScenarioLaunch,
  startFixtureService,
  writeUpdaterRunDescriptor,
} from './updater-scenario';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const e2eDirectory = resolve(currentDirectory, '..');
validateScenarioSourceDispositions([
  join(e2eDirectory, 'specs/updater.fixture-release.ts'),
]);
const runId = randomUUID();
const runnerArgs = process.argv.slice(2);
if (runnerArgs.some((argument) => argument !== '--pin')) {
  throw new Error('Updater Scenario accepts only the optional --pin argument');
}
const pinRequested = runnerArgs.includes('--pin');
let cancellationRequested = false;
let requestCancellation!: () => void;
const cancellation = new Promise<void>((resolveCancellation) => {
  requestCancellation = resolveCancellation;
});
const cancel = () => {
  if (cancellationRequested) return;
  cancellationRequested = true;
  requestCancellation();
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const layout = createUpdaterScenarioSandbox(runId);
const fixture = await startFixtureService(layout.fixtureStateDirectory);
const descriptor = writeUpdaterRunDescriptor(layout, fixture.baseUrl);
const startedAt = new Date().toISOString();
let writeEvent = makeRunEventWriter(descriptor.eventLogPath, runId);
writeEvent(
  { type: 'run.started', payload: { platform: process.platform } },
  startedAt
);
writeEvent({
  type: 'scenario.started',
  payload: { scenarioId: descriptor.scenario, kind: 'Updater Scenario' },
});
writeEvent({
  type: 'attempt.started',
  payload: { scenarioId: descriptor.scenario, attempt: 1 },
});
writeEvent({ type: 'fixture.started', payload: { port: fixture.port } });

const videoPath = join(descriptor.artifactDirectory, 'execution.webm');
let videoRecording: ExecutionVideoRecording | undefined;
let videoFailure = '';
if (!process.env.OGI_E2E_RUNNER_PROBE_PATH) {
  try {
    videoRecording = await startExecutionVideo({ path: videoPath });
  } catch (cause) {
    videoFailure = cause instanceof Error ? cause.message : String(cause);
  }
}

function runScenarioAttempt(attempt: number) {
  const probeRunnerPath = process.env.OGI_E2E_RUNNER_PROBE_PATH;
  const launch = probeRunnerPath
    ? {
        command: process.execPath,
        args: [probeRunnerPath],
        detached: process.platform === 'linux',
      }
    : getUpdaterScenarioLaunch(process.platform);
  const { command, args, detached } =
    videoRecording?.display && launch.command === 'xvfb-run'
      ? { ...launch, command: launch.args[1]!, args: launch.args.slice(2) }
      : launch;
  const windowsJobResultPath = join(
    descriptor.artifactDirectory,
    `attempt-${attempt}-windows-job.json`
  );
  const expectedAssertionExitPath = join(
    descriptor.artifactDirectory,
    `attempt-${attempt}-expected-assertion-exit.json`
  );
  return runTrackedAttempt({
    launch: {
      command,
      args,
      options: {
        cwd: e2eDirectory,
        detached,
        env: {
          ...process.env,
          ...(videoRecording?.display
            ? { DISPLAY: videoRecording.display }
            : {}),
          OGI_RUN_DESCRIPTOR: descriptor.descriptorPath,
          OGI_SCENARIO_ATTEMPT: String(attempt),
          OGI_WINDOWS_JOB_RESULT: windowsJobResultPath,
          OGI_EXPECTED_ASSERTION_EXIT: expectedAssertionExitPath,
        },
        stdio: 'inherit',
      },
    },
    cancellation: Effect.promise(() => cancellation),
    completionTimeout: '2 minutes',
    completionCondition: 'deterministic Updater Scenario completion',
    windowsJobResultPath,
    onStarted: (child) => {
      writeEvent({
        type: 'process.started',
        payload: { pid: child.pid!, name: 'WebdriverIO Updater Scenario' },
      });
    },
    onStopped: ({ child, leaked }) => {
      writeEvent = makeRunEventWriter(
        descriptor.eventLogPath,
        runId,
        replayRunEventLog(descriptor.eventLogPath).lastSequence
      );
      writeEvent({
        type: 'process.stopped',
        payload: {
          pid: child.pid!,
          leaked,
        },
      });
    },
  });
}

let finalOutcome: TerminalOutcome = 'Aborted';
const program = Effect.gen(function* () {
  const recordedAttemptOutcomes: AttemptOutcome[] = [];
  let failureDetail = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const sequenceBeforeAttempt = replayRunEventLog(
      descriptor.eventLogPath
    ).lastSequence;
    const attemptExit = yield* Effect.exit(runScenarioAttempt(attempt));
    const attemptEvents = readRunEvents(descriptor.eventLogPath).slice(
      sequenceBeforeAttempt
    );
    const failedAssertion = attemptEvents.find(
      (
        event
      ): event is Extract<
        (typeof attemptEvents)[number],
        { type: 'step.completed' }
      > => event.type === 'step.completed' && event.payload.outcome === 'Failed'
    );
    let attemptOutcome: AttemptOutcome;
    if (Exit.isFailure(attemptExit)) {
      attemptOutcome = 'Infrastructure Failed';
      failureDetail = Cause.pretty(attemptExit.cause);
    } else if (Exit.isFailure(attemptExit.value.inspectionExit)) {
      attemptOutcome = 'Infrastructure Failed';
      failureDetail = Cause.pretty(attemptExit.value.inspectionExit.cause);
    } else if (Exit.isFailure(attemptExit.value.cleanupExit)) {
      attemptOutcome = 'Infrastructure Failed';
      failureDetail = Cause.pretty(attemptExit.value.cleanupExit.cause);
    } else if (attemptExit.value.completion.kind === 'cancelled') {
      attemptOutcome = 'Cancelled';
    } else if (attemptExit.value.unexpectedSurvivors.length > 0) {
      attemptOutcome = 'Infrastructure Failed';
      failureDetail = `Unexpected surviving product processes: ${attemptExit.value.unexpectedSurvivors.join(', ')}`;
    } else if (Exit.isFailure(attemptExit.value.completion.processExit)) {
      const expectedAssertionExit =
        failedAssertion?.payload.expectedProcessExit === true &&
        hasExpectedAssertionExitConfirmation(
          join(
            descriptor.artifactDirectory,
            `attempt-${attempt}-expected-assertion-exit.json`
          )
        );
      attemptOutcome = classifyAttemptProcessFailure(
        Option.getOrUndefined(
          Cause.failureOption(attemptExit.value.completion.processExit.cause)
        ),
        expectedAssertionExit
      );
      failureDetail = Cause.pretty(
        attemptExit.value.completion.processExit.cause
      );
    } else if (failedAssertion) {
      attemptOutcome = 'Failed';
      failureDetail =
        failedAssertion.payload.error ?? 'Updater Scenario assertion failed';
    } else {
      attemptOutcome = 'Passed';
    }
    recordedAttemptOutcomes.push(attemptOutcome);
    writeEvent({
      type: 'attempt.completed',
      payload: { attempt, outcome: attemptOutcome },
    });
    if (attempt === 1 && attemptOutcome === 'Failed') {
      writeEvent({
        type: 'retry.scheduled',
        payload: {
          scenarioId: descriptor.scenario,
          fromAttempt: 1,
          toAttempt: 2,
          reason: failureDetail || 'Scenario assertion failed',
        },
      });
      writeEvent({
        type: 'attempt.started',
        payload: { scenarioId: descriptor.scenario, attempt: 2 },
      });
      continue;
    }
    break;
  }

  if (videoRecording) {
    const videoExit = yield* Effect.exit(
      Effect.tryPromise(() => stopExecutionVideo(videoRecording!))
    );
    if (Exit.isFailure(videoExit)) {
      videoFailure = Cause.pretty(videoExit.cause);
    }
  }

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
  const fixtureInfrastructureFailed = Exit.isFailure(fixtureCloseExit);
  if (fixtureInfrastructureFailed) {
    failureDetail = Cause.pretty(fixtureCloseExit.cause);
  }

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

  const outcome: TerminalOutcome = fixtureInfrastructureFailed
    ? 'Infrastructure Failed'
    : classifyRunOutcome(recordedAttemptOutcomes);
  finalOutcome = outcome;
  const reliabilityReportPath = join(
    descriptor.artifactDirectory,
    'reliability.json'
  );
  const htmlReportPath = join(descriptor.sandboxDirectory, 'report.html');
  const requiredCheck = getRequiredCheckResult(outcome);
  const shouldRetain = pinRequested || outcome !== 'Passed';
  writeFileSync(
    reliabilityReportPath,
    JSON.stringify(
      {
        version: 1,
        runId,
        outcome,
        attempts: recordedAttemptOutcomes,
        requiredCheck,
        retained: shouldRetain,
        ...(failureDetail ? { failureDetail } : {}),
      },
      null,
      2
    )
  );
  writeFileSync(
    htmlReportPath,
    renderRunHtmlReport(descriptor.eventLogPath, outcome)
  );
  if (shouldRetain) {
    finalizeRunRetention({
      runId,
      sandboxDirectory: descriptor.sandboxDirectory,
      outcome,
      createdAt: startedAt,
      pinned: pinRequested,
      videoPaths: [videoPath],
    });
  }
  const artifacts = [
    ['video', videoPath],
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
    ...([1, 2] as const).flatMap((attempt) => [
      [
        'windows-job-result',
        join(
          descriptor.artifactDirectory,
          `attempt-${attempt}-windows-job.json`
        ),
      ] as const,
      [
        'assertion-exit-evidence',
        join(
          descriptor.artifactDirectory,
          `attempt-${attempt}-expected-assertion-exit.json`
        ),
      ] as const,
    ]),
    ['reliability-report', reliabilityReportPath],
    ['html-report', htmlReportPath],
    ...(shouldRetain
      ? ([
          [
            'retention-manifest',
            join(descriptor.sandboxDirectory, 'retention.json'),
          ],
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
        payload: { artifactType, path: artifactPath },
      });
    }
  }
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
  writeFileSync(
    htmlReportPath,
    renderRunHtmlReport(descriptor.eventLogPath, outcome)
  );
  console.log(`Run Event Log: ${descriptor.eventLogPath}`);
  console.log(`Scenario Sandbox: ${descriptor.sandboxDirectory}`);
  console.log(
    `Required check: ${requiredCheck.passed ? 'Passed' : 'Failed'} (${outcome})`
  );
  if (!shouldRetain) {
    finalizeRunRetention({
      runId,
      sandboxDirectory: descriptor.sandboxDirectory,
      outcome,
      createdAt: startedAt,
      videoPaths: [videoPath],
    });
    console.log('Scenario Sandbox deleted by successful-run retention policy');
  }
  const retention = applyRunRetention(getDefaultRunRoot());
  if (retention.deleted.length > 0) {
    console.log(`Expired retained runs deleted: ${retention.deleted.length}`);
  }
  if (failureDetail) console.error(failureDetail);
});

const exit = await Effect.runPromiseExit(program);
if (videoRecording && !videoRecording.stopped) {
  await stopExecutionVideo(videoRecording).catch(() => undefined);
}
process.off('SIGINT', cancel);
process.off('SIGTERM', cancel);
process.exitCode =
  Exit.isSuccess(exit) && getRequiredCheckResult(finalOutcome).passed ? 0 : 1;
