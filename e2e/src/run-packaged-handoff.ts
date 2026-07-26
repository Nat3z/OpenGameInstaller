import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Data, Effect, Exit } from 'effect';
import {
  assertProductionPackagingBoundary,
  buildPackagedHandoffArtifacts,
  copySyntheticOldInstallation,
  createPackagedHandoffSandbox,
  findUnexpectedOfflineTraffic,
  findUnexpectedRuntimeLogErrors,
  INCREMENTAL_UPDATE_MODES,
  type IncrementalUpdateMode,
  installPackagedApplicationArtifact,
  RECOVERY_FAILURE_CASES,
  type RecoveryFailureCase,
  seedOfflineFixtureGame,
  startPackagedHandoffFixture,
  verifyProductionPackagingBoundary,
  writePackagedHandoffRunDescriptor,
} from './packaged-handoff';
import {
  findTrackedProcessSurvivors,
  type ProcessTreeTracker,
  readWindowsJobSurvivors,
  spawnTrackedProcess,
  terminateProcessTree,
} from './process-tree';
import {
  makeRunEventWriter,
  readRunEvents,
  renderRunHtmlReport,
  replayRunEventLog,
  type TerminalOutcome,
} from './run-events';
import {
  applyRunRetention,
  classifyAttemptProcessFailure,
  finalizeRunRetention,
  getDefaultRunRoot,
  getRequiredCheckResult,
  hasExpectedAssertionExitConfirmation,
  validateScenarioSourceDispositions,
} from './run-reliability';

class ProductJourneySpawnError extends Data.TaggedError(
  'ProductJourneySpawnError'
)<{ readonly command: string; readonly cause?: unknown }> {}

class ProductJourneyProcessExitError extends Data.TaggedError(
  'ProductJourneyProcessExitError'
)<{
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}> {}

class ProductJourneyTimeoutError extends Data.TaggedError(
  'ProductJourneyTimeoutError'
)<{ readonly timeout: string }> {}

class ProductJourneyTrackingError extends Data.TaggedError(
  'ProductJourneyTrackingError'
)<{ readonly cause: unknown }> {}

class ProductJourneyFixtureError extends Data.TaggedError(
  'ProductJourneyFixtureError'
)<{ readonly cause: unknown }> {}

async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate an automation port');
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return port;
}

function waitForProcess(child: ChildProcess) {
  return new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      rejectExit(new ProductJourneyTimeoutError({ timeout: '5 minutes' }));
    }, 300_000);
    child.once('error', (cause) => {
      clearTimeout(timeout);
      rejectExit(
        new ProductJourneySpawnError({ command: child.spawnfile, cause })
      );
    });
    child.once('exit', (status, signal) => {
      clearTimeout(timeout);
      if (status === 0) {
        resolveExit();
      } else {
        rejectExit(new ProductJourneyProcessExitError({ status, signal }));
      }
    });
  });
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const e2eDirectory = resolve(currentDirectory, '..');
const repositoryDirectory = resolve(e2eDirectory, '..');
validateScenarioSourceDispositions([
  join(e2eDirectory, 'specs/packaged-handoff.ts'),
]);
const platform = process.platform === 'win32' ? 'win32' : 'linux';
const pinRequested = process.argv.includes('--pin');
const recoveryArgument = process.argv.find((argument) =>
  argument.startsWith('--recovery-failure=')
);
const recoveryFailure = (recoveryArgument?.split('=')[1] ?? 'none') as
  | 'none'
  | RecoveryFailureCase;
if (
  recoveryFailure !== 'none' &&
  !RECOVERY_FAILURE_CASES.includes(recoveryFailure)
) {
  throw new Error(`Unknown recovery failure case: ${recoveryFailure}`);
}
const incrementalArgument = process.argv.find((argument) =>
  argument.startsWith('--incremental-update=')
);
const incrementalUpdate = (incrementalArgument?.split('=')[1] ??
  'none') as IncrementalUpdateMode;
if (!INCREMENTAL_UPDATE_MODES.includes(incrementalUpdate)) {
  throw new Error(`Unknown incremental update mode: ${incrementalUpdate}`);
}
const gameDownloadRecovery = process.argv.includes('--game-download-recovery');
const fixtureGameLifecycle = process.argv.includes('--fixture-game-lifecycle');
const offlineProductBehavior = process.argv.includes(
  '--offline-product-behavior'
);
const deterministicTorrentInstallation = process.argv.includes(
  '--deterministic-torrent-installation'
);
if (
  (gameDownloadRecovery ||
    fixtureGameLifecycle ||
    offlineProductBehavior ||
    deterministicTorrentInstallation ||
    incrementalUpdate !== 'none') &&
  recoveryFailure !== 'none'
) {
  throw new Error('Scenario modes cannot run with an updater recovery failure');
}
if (
  [
    gameDownloadRecovery,
    fixtureGameLifecycle,
    offlineProductBehavior,
    deterministicTorrentInstallation,
    incrementalUpdate !== 'none',
  ].filter(Boolean).length > 1
) {
  throw new Error('Only one Product Journey scenario mode may run at a time');
}
const runId = randomUUID();
const initialDescriptor = createPackagedHandoffSandbox(
  runId,
  platform,
  process.env.OGI_PACKAGED_ATTEMPT_SANDBOX,
  process.env.OGI_PACKAGED_ATTEMPT_OWNERSHIP_TOKEN
);
const attemptResultPath = process.env.OGI_PACKAGED_ATTEMPT_RESULT;
if (attemptResultPath) {
  writeFileSync(
    attemptResultPath,
    JSON.stringify({
      runId,
      sandboxDirectory: initialDescriptor.sandboxDirectory,
      outcome: 'Aborted',
      failure: 'Product Journey attempt did not reach terminal completion',
    })
  );
}
const builds = buildPackagedHandoffArtifacts({
  outputDirectory: join(initialDescriptor.artifactDirectory, 'builds'),
  applicationBundleDirectory: join(repositoryDirectory, 'application/out'),
  applicationMainPath: join(
    repositoryDirectory,
    'application/e2e-product-main.cjs'
  ),
  applicationOnlineStatePath: join(
    repositoryDirectory,
    'application/src/electron/lib/online-state.mjs'
  ),
  fixtureServicePath: join(repositoryDirectory, 'e2e/fixture-service.cjs'),
  trafficGuardPath: join(repositoryDirectory, 'e2e/offline-traffic-guard.cjs'),
  descriptorValidatorPath: join(
    repositoryDirectory,
    'e2e/src/packaged-handoff-run-descriptor.cjs'
  ),
  updaterBundleDirectory: join(repositoryDirectory, 'updater/dist'),
  updaterPublicDirectory: join(repositoryDirectory, 'updater/public'),
  updaterMainPath: join(
    repositoryDirectory,
    'updater/e2e-product-journey-main.cjs'
  ),
  updaterOfflineDecisionPath: join(
    repositoryDirectory,
    'updater/src/offline-decision.mjs'
  ),
  fixtureAddonDirectory: join(repositoryDirectory, 'e2e/fixture-addon'),
  fixtureWebSocketModuleDirectory: join(repositoryDirectory, 'node_modules/ws'),
  updaterUpdateEnginePath: join(
    repositoryDirectory,
    'updater/src/update-engine.mjs'
  ),
  updaterProductionCoordinatorPath: join(
    repositoryDirectory,
    'updater/src/production-update-coordinator.mjs'
  ),
});
const currentBuild = builds.find((build) => build.platform === platform);
if (!currentBuild) throw new Error(`No ${platform} E2E artifact was built`);
rmSync(initialDescriptor.packagedUpdaterDirectory, {
  recursive: true,
  force: true,
});
cpSync(
  currentBuild.packagedUpdaterDirectory,
  initialDescriptor.packagedUpdaterDirectory,
  { recursive: true }
);
if (offlineProductBehavior) {
  installPackagedApplicationArtifact(
    initialDescriptor,
    currentBuild.currentApplicationArtifactPath
  );
} else {
  copySyntheticOldInstallation(
    incrementalUpdate === 'none'
      ? currentBuild.syntheticOldInstallationDirectory
      : currentBuild.incrementalOldInstallationDirectory,
    initialDescriptor.installationDirectory
  );
}
mkdirSync(join(initialDescriptor.sandboxDirectory, 'downloads'), {
  recursive: true,
});
writeFileSync(
  join(initialDescriptor.fixtureStateDirectory, 'prerequisites.json'),
  JSON.stringify({ tools: 'available-in-sandbox', hostInstallRequired: false })
);
if (fixtureGameLifecycle) {
  writeFileSync(
    join(
      initialDescriptor.sandboxDirectory,
      'downloads',
      'unrelated-sentinel.txt'
    ),
    'fixture lifecycle sentinel\n'
  );
}
const fixture = await startPackagedHandoffFixture(
  initialDescriptor.fixtureStateDirectory,
  currentBuild.currentApplicationArtifactPath,
  gameDownloadRecovery,
  currentBuild.incrementalPatchPath,
  incrementalUpdate,
  currentBuild.incrementalOldBlockmapPath,
  deterministicTorrentInstallation
);
const descriptor = writePackagedHandoffRunDescriptor(
  initialDescriptor,
  fixture.baseUrl,
  await allocateLoopbackPort(),
  await allocateLoopbackPort(),
  await allocateLoopbackPort(),
  recoveryFailure,
  gameDownloadRecovery,
  fixtureGameLifecycle,
  offlineProductBehavior,
  incrementalUpdate,
  deterministicTorrentInstallation,
  fixture.torrent ?? null
);
if (offlineProductBehavior) {
  seedOfflineFixtureGame(
    descriptor,
    join(
      e2eDirectory,
      'node_modules/electron/dist',
      platform === 'win32' ? 'electron.exe' : 'electron'
    )
  );
}
const optionDirectory = join(
  descriptor.applicationStateDirectory,
  'config/option'
);
mkdirSync(optionDirectory, { recursive: true });
writeFileSync(
  join(optionDirectory, 'developer.json'),
  JSON.stringify({
    clientSdkUrl: `ws://127.0.0.1:${descriptor.clientSdkPort}`,
  })
);
const startedAt = new Date().toISOString();
let writeEvent = makeRunEventWriter(descriptor.eventLogPath, descriptor.runId);
writeEvent(
  { type: 'run.started', payload: { platform: process.platform } },
  startedAt
);
const scenarioId = gameDownloadRecovery
  ? 'interrupted-game-download-recovery'
  : fixtureGameLifecycle
    ? 'fixture-game-lifecycle'
    : offlineProductBehavior
      ? 'offline-product-behavior'
      : deterministicTorrentInstallation
        ? 'deterministic-torrent-installation'
        : incrementalUpdate !== 'none'
          ? `incremental-update:${incrementalUpdate}`
          : recoveryFailure === 'none'
            ? descriptor.scenario
            : `last-known-good-recovery:${recoveryFailure}`;
writeEvent({
  type: 'scenario.started',
  payload: {
    scenarioId,
    kind:
      recoveryFailure === 'none' && incrementalUpdate === 'none'
        ? 'Product Journey'
        : 'Updater Scenario',
  },
});
writeEvent({
  type: 'attempt.started',
  payload: { scenarioId, attempt: 1 },
});
writeEvent({
  type: 'fixture.started',
  payload: { port: Number(new URL(fixture.baseUrl).port) },
});

let child: ChildProcess | undefined;
let processTracker: ProcessTreeTracker | undefined;
let failure: unknown;
let processFailure: unknown;
let fixtureCloseFailure: unknown;
let leaked = false;
let leakedProcessPids: number[] = [];
const windowsJobResultPath = join(
  descriptor.artifactDirectory,
  'windows-job-result.json'
);
const expectedAssertionExitPath = join(
  descriptor.artifactDirectory,
  'expected-assertion-exit.json'
);
try {
  const command = platform === 'linux' ? 'xvfb-run' : 'powershell.exe';
  const args =
    platform === 'linux'
      ? ['-a', 'bunx', 'wdio', 'run', './product-journey-wdio.conf.ts']
      : [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          './src/windows-job-wrapper.ps1',
          'bunx',
          'wdio',
          'run',
          './product-journey-wdio.conf.ts',
        ];
  try {
    const launched = await spawnTrackedProcess(command, args, {
      cwd: e2eDirectory,
      detached: platform === 'linux',
      env: {
        ...process.env,
        OGI_RUN_DESCRIPTOR: descriptor.descriptorPath,
        OGI_WINDOWS_JOB_RESULT: windowsJobResultPath,
        OGI_EXPECTED_ASSERTION_EXIT: expectedAssertionExitPath,
      },
      stdio: 'inherit',
    });
    child = launched.child;
    processTracker = launched.tracker;
  } catch (cause) {
    throw new ProductJourneyTrackingError({ cause });
  }
  if (!child.pid) throw new ProductJourneySpawnError({ command });
  writeEvent({
    type: 'process.started',
    payload: { pid: child.pid, name: 'WebdriverIO Product Journey' },
  });
  await waitForProcess(child);
} catch (cause) {
  processFailure = cause;
  failure = cause;
} finally {
  writeEvent = makeRunEventWriter(
    descriptor.eventLogPath,
    descriptor.runId,
    replayRunEventLog(descriptor.eventLogPath).lastSequence
  );
  if (child) {
    let unexpectedSurvivors: number[] = [];
    if (
      (process.platform === 'win32' || processTracker) &&
      (child.exitCode !== null || child.signalCode !== null)
    ) {
      try {
        if (process.platform !== 'win32') await Bun.sleep(500);
        unexpectedSurvivors =
          process.platform === 'win32'
            ? readWindowsJobSurvivors(windowsJobResultPath)
            : await findTrackedProcessSurvivors(
                processTracker,
                child.pid ? [child.pid] : []
              );
      } catch (cause) {
        processFailure = new ProductJourneyTrackingError({ cause });
        if (!failure) failure = processFailure;
      }
    }
    const cleanup = await Effect.runPromiseExit(
      terminateProcessTree(child, processTracker)
    );
    leakedProcessPids = unexpectedSurvivors;
    leaked = unexpectedSurvivors.length > 0 || Exit.isFailure(cleanup);
    writeEvent({
      type: 'process.stopped',
      payload: { pid: child.pid ?? 0, leaked },
    });
    if (leaked && !failure) {
      failure = new ProductJourneyTrackingError({
        cause: `Unexpected surviving product processes: ${unexpectedSurvivors.join(', ')}`,
      });
    }
  }
  try {
    await fixture.close();
  } catch (cause) {
    fixtureCloseFailure = new ProductJourneyFixtureError({ cause });
    if (!failure) failure = fixtureCloseFailure;
  }
}

const requestLines = readFileSync(fixture.requestLogPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean);
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
const applicationRendererLogPath = join(
  descriptor.artifactDirectory,
  'packaged-application-renderer.log'
);
const artifacts = [
  [
    'main-log',
    join(descriptor.artifactDirectory, 'packaged-application-main.log'),
  ],
  ['renderer-log', applicationRendererLogPath],
  [
    'main-log',
    join(
      descriptor.artifactDirectory,
      'packaged-application-relaunch-process.log'
    ),
  ],
  ['main-log', join(descriptor.artifactDirectory, 'fixture-game.log')],
  [
    'updater-main-log',
    join(descriptor.artifactDirectory, 'packaged-updater-main.log'),
  ],
  [
    'updater-renderer-log',
    join(descriptor.artifactDirectory, 'packaged-updater-renderer.log'),
  ],
  ['fixture-requests', fixture.requestLogPath],
  [
    'traffic-log',
    join(descriptor.artifactDirectory, 'packaged-updater-traffic.jsonl'),
  ],
  [
    'traffic-log',
    join(descriptor.artifactDirectory, 'packaged-application-traffic.jsonl'),
  ],
  ['handoff-log', descriptor.handoffLogPath],
  ['startup-health', descriptor.startupHealthPath],
  ['run-descriptor', descriptor.descriptorPath],
  ['windows-job-result', windowsJobResultPath],
  ['assertion-exit-evidence', expectedAssertionExitPath],
] as const;
for (const [artifactType, path] of artifacts) {
  if (existsSync(path)) {
    writeEvent({
      type: 'artifact.created',
      payload: {
        artifactType,
        path: relative(descriptor.sandboxDirectory, path),
      },
    });
  }
}
const unexpectedRuntimeErrors = findUnexpectedRuntimeLogErrors(
  artifacts
    .filter(([artifactType]) => artifactType.includes('log'))
    .map(([, path]) => path)
);
if (unexpectedRuntimeErrors.length > 0 && !failure) {
  failure = new Error(
    `Unexpected fatal or unhandled runtime log errors:\n${unexpectedRuntimeErrors
      .map(
        ({ path, line }) =>
          `${relative(descriptor.sandboxDirectory, path)}: ${line}`
      )
      .join('\n')}`
  );
}
if (offlineProductBehavior) {
  const trafficLogPaths = [
    join(descriptor.artifactDirectory, 'packaged-updater-traffic.jsonl'),
    join(descriptor.artifactDirectory, 'packaged-application-traffic.jsonl'),
  ];
  const unexpectedTraffic = findUnexpectedOfflineTraffic(
    trafficLogPaths,
    fixture.requestLogPath
  );
  const applicationRendererLog = existsSync(applicationRendererLogPath)
    ? readFileSync(applicationRendererLogPath, 'utf8')
    : '';
  const offlinePreLaunchHooksSkipped = applicationRendererLog.includes(
    'Offline mode: skipping addon pre-launch hooks'
  );
  const offlineAddonTaskQueriesSkipped = applicationRendererLog.includes(
    'Offline mode: skipping addon task queries'
  );
  const websocketUnhandledErrors = unexpectedRuntimeErrors.filter(({ line }) =>
    /Websocket is not open/i.test(line)
  );
  const trafficEntries = trafficLogPaths.flatMap((path) =>
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  );
  const handoffEntries = readFileSync(descriptor.handoffLogPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase?: string; pid?: number });
  const applicationPid = handoffEntries.find(
    (entry) => entry.phase === 'offline-last-known-good-launched'
  )?.pid;
  const fixtureGameMarkerPath = join(
    descriptor.fixtureStateDirectory,
    'fixture-game-launch.json'
  );
  const fixtureGamePid = existsSync(fixtureGameMarkerPath)
    ? (
        JSON.parse(readFileSync(fixtureGameMarkerPath, 'utf8')) as {
          pid?: number;
        }
      ).pid
    : undefined;
  const guardedPids = new Set(
    trafficEntries
      .filter((entry) => entry.transport === 'guard-install')
      .map((entry) => Number(entry.pid))
      .filter(Number.isInteger)
  );
  const missingGuardCoverage = [applicationPid, fixtureGamePid].filter(
    (pid): pid is number =>
      typeof pid === 'number' && Number.isInteger(pid) && !guardedPids.has(pid)
  );
  const updaterGuardPresent = trafficEntries.some(
    (entry) =>
      entry.transport === 'guard-install' && entry.product === 'updater'
  );
  if (
    (requestLines.length > 0 ||
      unexpectedTraffic.length > 0 ||
      missingGuardCoverage.length > 0 ||
      !updaterGuardPresent ||
      !offlinePreLaunchHooksSkipped ||
      !offlineAddonTaskQueriesSkipped ||
      websocketUnhandledErrors.length > 0) &&
    !failure
  ) {
    failure = new Error(
      `Offline Product Journey observed unexpected traffic: ${JSON.stringify({
        fixtureRequests: requestLines.map((line) => JSON.parse(line)),
        unexpectedTraffic,
        missingGuardCoverage,
        updaterGuardPresent,
        offlinePreLaunchHooksSkipped,
        offlineAddonTaskQueriesSkipped,
        websocketUnhandledErrors,
      })}`
    );
  }
  const offlineTrafficAssertionPath = join(
    descriptor.artifactDirectory,
    'offline-traffic-assertion.json'
  );
  writeFileSync(
    offlineTrafficAssertionPath,
    JSON.stringify(
      {
        fixtureRequests: requestLines.length,
        unexpectedTraffic: unexpectedTraffic.length,
        guardedPids: [...guardedPids],
        applicationPid,
        fixtureGamePid,
        missingGuardCoverage,
        updaterGuardPresent,
        offlinePreLaunchHooksSkipped,
        offlineAddonTaskQueriesSkipped,
        websocketUnhandledErrors: websocketUnhandledErrors.length,
        assertedOfflineAddonRuntimeUnused:
          offlinePreLaunchHooksSkipped &&
          offlineAddonTaskQueriesSkipped &&
          websocketUnhandledErrors.length === 0,
        assertedZeroUnexpectedTraffic:
          requestLines.length === 0 &&
          unexpectedTraffic.length === 0 &&
          missingGuardCoverage.length === 0 &&
          updaterGuardPresent,
      },
      null,
      2
    )
  );
  writeEvent({
    type: 'artifact.created',
    payload: {
      artifactType: 'offline-traffic-assertion',
      path: relative(descriptor.sandboxDirectory, offlineTrafficAssertionPath),
    },
  });
}
if (incrementalUpdate !== 'none') {
  const trafficLogPaths = [
    join(descriptor.artifactDirectory, 'packaged-updater-traffic.jsonl'),
    join(descriptor.artifactDirectory, 'packaged-application-traffic.jsonl'),
  ];
  const unexpectedTraffic = findUnexpectedOfflineTraffic(
    trafficLogPaths,
    fixture.requestLogPath
  );
  const trafficEntries = trafficLogPaths.flatMap((path) =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : []
  );
  const handoffEntries = readFileSync(descriptor.handoffLogPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          phase?: string;
          pid?: number;
          module?: string;
          marker?: string;
        }
    );
  const requiredPids = handoffEntries
    .filter((entry) =>
      ['application-launched', 'last-known-good-process-started'].includes(
        entry.phase ?? ''
      )
    )
    .map((entry) => entry.pid)
    .filter((pid): pid is number => Number.isInteger(pid));
  const guardedPids = new Set(
    trafficEntries
      .filter((entry) => entry.transport === 'guard-install')
      .map((entry) => Number(entry.pid))
      .filter(Number.isInteger)
  );
  const missingGuardCoverage = requiredPids.filter(
    (pid) => !guardedPids.has(pid)
  );
  const updaterGuardPresent = trafficEntries.some(
    (entry) =>
      entry.transport === 'guard-install' && entry.product === 'updater'
  );
  const productionCoordinatorExecuted = handoffEntries.some(
    (entry) =>
      entry.phase === 'production-update-coordinator-executed' &&
      entry.module === 'support/production-update-coordinator.mjs' &&
      entry.marker === 'ogi-production-update-coordinator-v2'
  );
  const assertionPath = join(
    descriptor.artifactDirectory,
    'incremental-network-and-engine-assertion.json'
  );
  writeFileSync(
    assertionPath,
    JSON.stringify(
      {
        unexpectedTraffic,
        requiredPids,
        guardedPids: [...guardedPids],
        missingGuardCoverage,
        updaterGuardPresent,
        productionCoordinatorExecuted,
      },
      null,
      2
    )
  );
  writeEvent({
    type: 'artifact.created',
    payload: {
      artifactType: 'incremental-network-engine-assertion',
      path: relative(descriptor.sandboxDirectory, assertionPath),
    },
  });
  if (
    (unexpectedTraffic.length > 0 ||
      missingGuardCoverage.length > 0 ||
      !updaterGuardPresent ||
      !productionCoordinatorExecuted) &&
    !failure
  ) {
    failure = new Error(
      `Incremental network containment or production engine boundary failed: ${JSON.stringify(
        {
          unexpectedTraffic,
          missingGuardCoverage,
          updaterGuardPresent,
          productionCoordinatorExecuted,
        }
      )}`
    );
  }
}
if (deterministicTorrentInstallation) {
  const trafficLogPath = join(
    descriptor.artifactDirectory,
    'packaged-application-traffic.jsonl'
  );
  const unexpectedTraffic = findUnexpectedOfflineTraffic(
    [trafficLogPath],
    fixture.requestLogPath
  );
  const trafficEntries = existsSync(trafficLogPath)
    ? readFileSync(trafficLogPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  const targets = trafficEntries.map((entry) => String(entry.target ?? ''));
  const isolationMode = process.env.OGI_TORRENT_NETWORK_ISOLATION ?? 'none';
  const networkAddresses = Object.entries(networkInterfaces()).flatMap(
    ([name, addresses]) =>
      (addresses ?? []).map((address) => ({
        name,
        address: address.address,
        family: address.family,
        internal: address.internal,
      }))
  );
  const nonLoopbackAddresses = networkAddresses.filter(
    (address) => !address.internal
  );
  const currentNetworkNamespace =
    process.platform === 'linux' ? readlinkSync('/proc/self/ns/net') : null;
  const parentNetworkNamespace =
    process.env.OGI_TORRENT_PARENT_NETWORK_NAMESPACE ?? null;
  const namespaceIsolated =
    process.platform === 'linux' &&
    isolationMode === 'linux-bwrap' &&
    currentNetworkNamespace !== parentNetworkNamespace &&
    nonLoopbackAddresses.length === 0;
  const listenerTargets = trafficEntries
    .filter((entry) => entry.transport === 'node-net-listen')
    .map((entry) => String(entry.target ?? ''));
  const wildcardApplicationListeners = listenerTargets.filter(
    (target) => target.startsWith(':::') || target.startsWith('0.0.0.0:')
  );
  const trackerListenerAddress = fixture.torrent?.trackerAddress ?? null;
  const seederPeerAddress = fixture.torrent?.peerAddress ?? null;
  const seederUsesWildcard = ['::', '0.0.0.0'].includes(
    seederPeerAddress ?? ''
  );
  const listenerIsolationPassed =
    process.platform === 'linux'
      ? namespaceIsolated &&
        trackerListenerAddress === '127.0.0.1' &&
        seederUsesWildcard &&
        wildcardApplicationListeners.length > 0
      : isolationMode === 'windows-firewall-program-scope';
  const isolationAssertionPath = join(
    descriptor.artifactDirectory,
    'torrent-network-isolation-assertion.json'
  );
  writeFileSync(
    isolationAssertionPath,
    JSON.stringify(
      {
        version: 1,
        isolationMode,
        currentNetworkNamespace,
        parentNetworkNamespace,
        namespaceIsolated,
        networkAddresses,
        nonLoopbackAddresses,
        trackerListenerAddress,
        seederPeerAddress,
        seederUsesWildcard,
        applicationListenerTargets: listenerTargets,
        wildcardApplicationListeners,
        externallyReachableWildcardListener: !listenerIsolationPassed,
        passed: listenerIsolationPassed,
      },
      null,
      2
    )
  );
  writeEvent({
    type: 'artifact.created',
    payload: {
      artifactType: 'torrent-network-isolation-assertion',
      path: relative(descriptor.sandboxDirectory, isolationAssertionPath),
    },
  });
  const trackerObserved = targets.some((target) =>
    target.includes(descriptor.torrentTrackerUrl ?? 'unconfigured-tracker')
  );
  const peerObserved = targets.some(
    (target) =>
      target.includes(`127.0.0.1:${descriptor.torrentPeerPort}`) ||
      target.includes(`127.0.0.1/${descriptor.torrentPeerPort}`)
  );
  const guardInstalled = trafficEntries.some(
    (entry) =>
      entry.transport === 'guard-install' &&
      entry.expected === true &&
      typeof entry.product === 'string' &&
      (entry.product === 'application' ||
        entry.product.endsWith('application-descendant'))
  );
  const fixtureRequests = readFileSync(fixture.requestLogPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { path?: string; unexpected?: boolean });
  const torrentMetadataRequested = fixtureRequests.some(
    (entry) => entry.path === '/games/golden-journey.torrent'
  );
  const assertionPath = join(
    descriptor.artifactDirectory,
    'torrent-network-containment-assertion.json'
  );
  writeFileSync(
    assertionPath,
    JSON.stringify(
      {
        unexpectedTraffic,
        listenerIsolationPassed,
        isolationMode,
        guardInstalled,
        trackerObserved,
        peerObserved,
        torrentMetadataRequested,
        trackerUrl: descriptor.torrentTrackerUrl,
        peerPort: descriptor.torrentPeerPort,
      },
      null,
      2
    )
  );
  writeEvent({
    type: 'artifact.created',
    payload: {
      artifactType: 'torrent-network-containment-assertion',
      path: relative(descriptor.sandboxDirectory, assertionPath),
    },
  });
  if (
    (unexpectedTraffic.length > 0 ||
      !listenerIsolationPassed ||
      !guardInstalled ||
      !trackerObserved ||
      !peerObserved ||
      !torrentMetadataRequested) &&
    !failure
  ) {
    failure = new Error(
      `Torrent network containment failed: ${JSON.stringify({
        unexpectedTraffic,
        listenerIsolationPassed,
        isolationMode,
        guardInstalled,
        trackerObserved,
        peerObserved,
        torrentMetadataRequested,
      })}`
    );
  }
}
const boundary = verifyProductionPackagingBoundary(repositoryDirectory);
const boundaryPath = join(
  descriptor.artifactDirectory,
  'production-package-boundary.json'
);
writeFileSync(boundaryPath, JSON.stringify(boundary, null, 2));
writeEvent({
  type: 'artifact.created',
  payload: {
    artifactType: 'production-package-boundary',
    path: relative(descriptor.sandboxDirectory, boundaryPath),
  },
});
try {
  assertProductionPackagingBoundary(boundary);
} catch (cause) {
  if (!failure) failure = cause;
}
const failedAssertion = readRunEvents(descriptor.eventLogPath).find(
  (
    event
  ): event is Extract<
    ReturnType<typeof readRunEvents>[number],
    { type: 'step.completed' }
  > => event.type === 'step.completed' && event.payload.outcome === 'Failed'
);
if (failedAssertion && !failure) {
  failure = new Error(
    failedAssertion.payload.error ?? 'Product Journey assertion failed'
  );
}
const expectedAssertionExit =
  failedAssertion?.payload.expectedProcessExit === true &&
  hasExpectedAssertionExitConfirmation(expectedAssertionExitPath);
const processFailureOutcome =
  processFailure === undefined
    ? undefined
    : classifyAttemptProcessFailure(processFailure, expectedAssertionExit);
const infrastructureFailed =
  leaked ||
  fixtureCloseFailure !== undefined ||
  processFailureOutcome === 'Infrastructure Failed';
const outcome: TerminalOutcome = failure
  ? infrastructureFailed
    ? 'Infrastructure Failed'
    : 'Failed'
  : 'Passed';
const requiredCheck = getRequiredCheckResult(outcome);
const failureDetail = failure
  ? failure instanceof Error && failure.message
    ? failure.message
    : JSON.stringify(failure)
  : '';
const shouldRetain = pinRequested || outcome !== 'Passed';
const reliabilityReportPath = join(
  descriptor.artifactDirectory,
  'reliability.json'
);
writeFileSync(
  reliabilityReportPath,
  JSON.stringify(
    {
      version: 1,
      runId: descriptor.runId,
      outcome,
      attempts: [outcome],
      requiredCheck,
      retained: shouldRetain,
      ...(failureDetail ? { failureDetail } : {}),
      ...(leakedProcessPids.length > 0 ? { leakedProcessPids } : {}),
    },
    null,
    2
  )
);
if (shouldRetain) {
  finalizeRunRetention({
    runId: descriptor.runId,
    sandboxDirectory: descriptor.sandboxDirectory,
    outcome,
    createdAt: startedAt,
    pinned: pinRequested,
  });
}
writeEvent({
  type: 'artifact.created',
  payload: {
    artifactType: 'reliability-report',
    path: relative(descriptor.sandboxDirectory, reliabilityReportPath),
  },
});
if (shouldRetain) {
  writeEvent({
    type: 'artifact.created',
    payload: { artifactType: 'retention-manifest', path: 'retention.json' },
  });
}
const htmlReportPath = join(descriptor.sandboxDirectory, 'report.html');
writeFileSync(
  htmlReportPath,
  renderRunHtmlReport(descriptor.eventLogPath, outcome)
);
writeEvent({
  type: 'artifact.created',
  payload: {
    artifactType: 'html-report',
    path: relative(descriptor.sandboxDirectory, htmlReportPath),
  },
});
writeEvent({
  type: 'attempt.completed',
  payload: { attempt: 1, outcome },
});
writeEvent({
  type: 'scenario.completed',
  payload: { scenarioId, outcome },
});
writeEvent({ type: 'run.completed', payload: { outcome } });
writeFileSync(
  join(descriptor.sandboxDirectory, 'summary.json'),
  JSON.stringify(replayRunEventLog(descriptor.eventLogPath), null, 2)
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
    runId: descriptor.runId,
    sandboxDirectory: descriptor.sandboxDirectory,
    outcome,
    createdAt: startedAt,
  });
  console.log('Scenario Sandbox deleted by successful-run retention policy');
}
const retention = applyRunRetention(getDefaultRunRoot());
if (retention.deleted.length > 0) {
  console.log(`Expired retained runs deleted: ${retention.deleted.length}`);
}
if (attemptResultPath) {
  writeFileSync(
    attemptResultPath,
    JSON.stringify({
      runId: descriptor.runId,
      sandboxDirectory: descriptor.sandboxDirectory,
      outcome,
      failure: failureDetail,
    })
  );
}
if (failure) {
  throw failure;
}
