import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Exit, Option } from 'effect';
import {
  createApplicationScenarioSandbox,
  ensureApplicationFailureEvidence,
  getApplicationScenarioLaunch,
  parseApplicationScenarioMode,
} from './application-scenario';
import {
  type ExecutionVideoRecording,
  startExecutionVideo,
  stopExecutionVideo,
} from './execution-video';
import { terminateProcessTree } from './process-tree';
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

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const e2eDirectory = resolve(currentDirectory, '..');
validateScenarioSourceDispositions([
  join(e2eDirectory, 'specs/application.visible-navigation.ts'),
]);
const runId = randomUUID();
const runnerArgs = process.argv.slice(2);
const pinRequested = runnerArgs.includes('--pin');
const mode = parseApplicationScenarioMode(
  runnerArgs.filter((argument) => argument !== '--pin')
);
const descriptor = createApplicationScenarioSandbox(runId, mode);
const observerAnnouncementPath = process.env.OGI_OBSERVER_ANNOUNCEMENT;
const announceObserverRun = (events?: ReturnType<typeof readRunEvents>) => {
  if (!observerAnnouncementPath) return;
  writeFileSync(
    observerAnnouncementPath,
    JSON.stringify({
      runId,
      sandboxDirectory: descriptor.sandboxDirectory,
      eventLogPath: descriptor.eventLogPath,
      ...(events ? { events } : {}),
    })
  );
};
announceObserverRun();
const mainLogPath = join(descriptor.artifactDirectory, 'application-main.log');
const rendererLogPath = join(
  descriptor.artifactDirectory,
  'application-renderer.log'
);
writeFileSync(mainLogPath, '');
writeFileSync(rendererLogPath, '');
const startedAt = new Date().toISOString();
let writeEvent = makeRunEventWriter(descriptor.eventLogPath, runId);
writeEvent(
  { type: 'run.started', payload: { platform: process.platform } },
  startedAt
);
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

function runScenarioAttempt(attempt: number) {
  const probeRunnerPath = process.env.OGI_E2E_RUNNER_PROBE_PATH;
  const launch = probeRunnerPath
    ? {
        command: process.execPath,
        args: [probeRunnerPath],
        detached: process.platform === 'linux',
      }
    : getApplicationScenarioLaunch(process.platform);
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
    completionCondition: 'observable Application Scenario completion',
    windowsJobResultPath,
    onStarted: (child) => {
      writeEvent({
        type: 'process.started',
        payload: { pid: child.pid!, name: 'WebdriverIO Application Scenario' },
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
let deliberateLeakedHelper: ChildProcess | undefined;
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
    } else if (attemptExit.value.completion.kind === 'cancelled') {
      attemptOutcome = 'Cancelled';
    } else if (attemptExit.value.unexpectedSurvivors.length > 0) {
      attemptOutcome = 'Infrastructure Failed';
      failureDetail = `Unexpected surviving product processes: ${attemptExit.value.unexpectedSurvivors.join(', ')}`;
    } else if (Exit.isFailure(attemptExit.value.cleanupExit)) {
      attemptOutcome = 'Infrastructure Failed';
      failureDetail = Cause.pretty(attemptExit.value.cleanupExit.cause);
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
        failedAssertion.payload.error ??
        'Application Scenario assertion failed';
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
  const processOutcome = classifyRunOutcome(recordedAttemptOutcomes);
  const detectedLeaks: Array<{ pid: number; name: string }> = [];
  if (descriptor.mode === 'helper-leak' && processOutcome === 'Passed') {
    deliberateLeakedHelper = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', descriptor.sandboxDirectory],
      { detached: true, stdio: 'ignore' }
    );
    if (!deliberateLeakedHelper.pid) {
      detectedLeaks.push({ pid: 1, name: 'unidentified helper process' });
    } else {
      detectedLeaks.push({
        pid: deliberateLeakedHelper.pid,
        name: 'application helper process',
      });
      writeEvent({
        type: 'process.started',
        payload: {
          pid: deliberateLeakedHelper.pid,
          name: 'Deliberate leaked application helper',
        },
      });
      writeEvent({
        type: 'process.stopped',
        payload: { pid: deliberateLeakedHelper.pid, leaked: true },
      });
    }
  }
  const outcome: TerminalOutcome = videoFailure
    ? 'Infrastructure Failed'
    : descriptor.mode === 'helper-leak'
      ? classifyRunOutcome(recordedAttemptOutcomes, { leaks: detectedLeaks })
      : processOutcome;
  if (videoFailure) failureDetail = videoFailure;
  finalOutcome = outcome;
  if (outcome !== 'Passed' && outcome !== 'Flaky') {
    yield* Effect.tryPromise({
      try: () =>
        ensureApplicationFailureEvidence(
          descriptor,
          failureDetail || `Application Scenario ended as ${outcome}`
        ),
      catch: (cause) => cause,
    });
  }
  writeEvent = makeRunEventWriter(
    descriptor.eventLogPath,
    runId,
    replayRunEventLog(descriptor.eventLogPath).lastSequence
  );
  const reliabilityReportPath = join(
    descriptor.artifactDirectory,
    'reliability.json'
  );
  const htmlReportPath = join(descriptor.sandboxDirectory, 'report.html');
  const requiredCheck = getRequiredCheckResult(outcome);
  const shouldRetain =
    pinRequested || (outcome !== 'Passed' && outcome !== 'Skipped');
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
    ['main-log', mainLogPath],
    ['renderer-log', rendererLogPath],
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
    ...(outcome !== 'Passed' && outcome !== 'Flaky'
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
  announceObserverRun(readRunEvents(descriptor.eventLogPath));
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
if (deliberateLeakedHelper) {
  await Effect.runPromise(terminateProcessTree(deliberateLeakedHelper));
}
if (cancellationPoll) clearInterval(cancellationPoll);
process.off('SIGINT', cancel);
process.off('SIGTERM', cancel);
process.exitCode =
  Exit.isSuccess(exit) && getRequiredCheckResult(finalOutcome).passed ? 0 : 1;
