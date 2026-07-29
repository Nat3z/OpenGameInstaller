import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Effect, Exit } from 'effect';
import {
  findTrackedProcessSurvivors,
  type ProcessTreeTracker,
  spawnTrackedProcess,
  terminateProcessTree,
} from './process-tree';
import {
  makeRunEventWriter,
  renderRunHtmlReport,
  replayRunEventLog,
  type TerminalOutcome,
} from './run-events';
import {
  type AttemptOutcome,
  applyRunRetention,
  classifyRunOutcome,
  finalizeRunRetention,
  getDefaultRunRoot,
  getRequiredCheckResult,
  readReliableAttemptEvidenceSummary,
  recordReliableAttemptEvidence,
  resolveOfflineChromedriverPath,
  shouldApplyRunRetention,
  validateScenarioSourceDispositions,
} from './run-reliability';

interface PackagedAttemptResult {
  runId: string;
  sandboxDirectory: string;
  outcome: AttemptOutcome;
  failure: string;
}

type AttemptProcess = {
  child: ChildProcess;
  tracker: ProcessTreeTracker | undefined;
  completion: Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>;
};

const MAX_ATTEMPT_RESULT_BYTES = 64 * 1024;
const ATTEMPT_OUTCOMES = new Set<AttemptOutcome>([
  'Passed',
  'Failed',
  'Cancelled',
  'Aborted',
  'Infrastructure Failed',
]);

type AttemptResultRead =
  | { kind: 'missing' }
  | { kind: 'invalid'; error: Error }
  | { kind: 'valid'; result: PackagedAttemptResult };

function readAttemptResult(
  path: string,
  expectedSandboxDirectory: string
): AttemptResultRead {
  if (!existsSync(path)) return { kind: 'missing' };
  try {
    const statistics = lstatSync(path);
    if (statistics.isSymbolicLink() || !statistics.isFile()) {
      throw new Error('attempt result is not a real file');
    }
    if (statistics.size > MAX_ATTEMPT_RESULT_BYTES) {
      throw new Error(
        `attempt result exceeds ${MAX_ATTEMPT_RESULT_BYTES} bytes`
      );
    }
    const descriptor = openSync(path, 'r');
    let contents: string;
    try {
      const buffer = Buffer.alloc(MAX_ATTEMPT_RESULT_BYTES + 1);
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_ATTEMPT_RESULT_BYTES) {
        throw new Error(
          `attempt result exceeds ${MAX_ATTEMPT_RESULT_BYTES} bytes`
        );
      }
      contents = buffer.toString('utf8', 0, bytesRead);
    } finally {
      closeSync(descriptor);
    }
    const value: unknown = JSON.parse(contents);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('attempt result is not an object');
    }
    const result = value as Record<string, unknown>;
    if (typeof result.runId !== 'string' || result.runId.length === 0) {
      throw new Error('attempt result runId is missing or invalid');
    }
    if (
      typeof result.sandboxDirectory !== 'string' ||
      resolve(result.sandboxDirectory) !== resolve(expectedSandboxDirectory)
    ) {
      throw new Error(
        'attempt result sandbox does not match the owned attempt'
      );
    }
    if (
      typeof result.outcome !== 'string' ||
      !ATTEMPT_OUTCOMES.has(result.outcome as AttemptOutcome)
    ) {
      throw new Error('attempt result outcome is missing or invalid');
    }
    if (typeof result.failure !== 'string') {
      throw new Error('attempt result failure detail is missing or invalid');
    }
    return {
      kind: 'valid',
      result: result as unknown as PackagedAttemptResult,
    };
  } catch (cause) {
    return {
      kind: 'invalid',
      error: new Error(
        `Product Journey attempt result is invalid: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      ),
    };
  }
}

async function awaitAttemptResult(
  path: string,
  expectedSandboxDirectory: string,
  timeoutMs = 500
) {
  const deadline = Date.now() + timeoutMs;
  let result: AttemptResultRead = { kind: 'missing' };
  do {
    result = readAttemptResult(path, expectedSandboxDirectory);
    if (result.kind === 'valid') return result.result;
    await Bun.sleep(25);
  } while (Date.now() < deadline);
  if (result.kind === 'invalid') throw result.error;
  return undefined;
}

function getUnexpectedAttemptCompletion(
  result: PackagedAttemptResult,
  processResult:
    | { status: number | null; signal: NodeJS.Signals | null }
    | undefined
) {
  if (!processResult) return 'attempt worker completion was not observed';
  if (processResult.signal !== null) {
    return `attempt worker terminated by signal ${processResult.signal}`;
  }
  const expectedStatus = result.outcome === 'Failed' ? 1 : 0;
  if (processResult.status !== expectedStatus) {
    return `attempt worker exited with status ${processResult.status}; expected ${expectedStatus} for ${result.outcome}`;
  }
  return undefined;
}

const OWNERSHIP_MARKER_NAME = '.ogi-attempt-owner.json';

type OwnedSandboxIdentity = { device: number; inode: number };

function isContainedPath(root: string, path: string) {
  const contained = relative(root, path);
  return (
    contained === '' ||
    (!contained.startsWith(`..${sep}`) &&
      contained !== '..' &&
      !isAbsolute(contained))
  );
}

function readOwnershipMarker(directory: string) {
  const markerPath = join(directory, OWNERSHIP_MARKER_NAME);
  const markerStat = lstatSync(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new Error('Product Journey ownership marker is not a real file');
  }
  if (process.platform !== 'win32' && (markerStat.mode & 0o222) !== 0) {
    throw new Error('Product Journey ownership marker is not immutable');
  }
  return JSON.parse(readFileSync(markerPath, 'utf8')) as Record<
    string,
    unknown
  >;
}

function verifyOwnedAttemptSandbox(
  containmentRoot: string,
  directory: string,
  expectedSandboxDirectory: string,
  ownershipToken: string
): OwnedSandboxIdentity {
  const resolvedRoot = resolve(containmentRoot);
  const resolvedDirectory = resolve(directory);
  if (!isContainedPath(resolvedRoot, resolvedDirectory)) {
    throw new Error(
      'Owned Product Journey sandbox escaped its containment root'
    );
  }
  let current = resolvedRoot;
  const rootStat = lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      'Product Journey run root is a symbolic link or reparse point'
    );
  }
  const components = relative(resolvedRoot, resolvedDirectory)
    .split(sep)
    .filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    const componentStat = lstatSync(current);
    if (componentStat.isSymbolicLink() || !componentStat.isDirectory()) {
      throw new Error(
        'Owned Product Journey sandbox contains a symbolic link or reparse point'
      );
    }
  }
  const realRoot = realpathSync(resolvedRoot);
  const realDirectory = realpathSync(resolvedDirectory);
  if (!isContainedPath(realRoot, realDirectory)) {
    throw new Error('Owned Product Journey sandbox real path escaped its root');
  }
  const marker = readOwnershipMarker(resolvedDirectory);
  if (
    marker.version !== 1 ||
    marker.token !== ownershipToken ||
    resolve(String(marker.sandboxDirectory)) !==
      resolve(expectedSandboxDirectory)
  ) {
    throw new Error(
      'Product Journey ownership marker did not match the attempt'
    );
  }
  const identity = lstatSync(resolvedDirectory);
  return { device: identity.dev, inode: identity.ino };
}

function removeTreeWithoutFollowingLinks(path: string) {
  let statistics: ReturnType<typeof lstatSync>;
  try {
    statistics = lstatSync(path);
  } catch {
    return;
  }
  if (statistics.isSymbolicLink() || !statistics.isDirectory()) {
    unlinkSync(path);
    return;
  }
  for (const entry of readdirSync(path)) {
    removeTreeWithoutFollowingLinks(join(path, entry));
  }
  rmdirSync(path);
}

function cleanupOwnedSandbox(path: string, ownershipToken: string) {
  try {
    const statistics = lstatSync(path);
    if (statistics.isSymbolicLink()) {
      unlinkSync(path);
      return;
    }
    if (
      statistics.isDirectory() &&
      readOwnershipMarker(path).token === ownershipToken
    ) {
      removeTreeWithoutFollowingLinks(path);
    }
  } catch {
    // Ownership mismatches must never trigger recursive deletion of foreign data.
  }
}

function listEvidenceFiles(
  attemptDirectory: string,
  directory = attemptDirectory
): string[] {
  const realAttemptDirectory = realpathSync(attemptDirectory);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const statistics = lstatSync(path);
    if (statistics.isSymbolicLink()) {
      throw new Error(
        `Product Journey attempt evidence contains a symbolic link or reparse point: ${path}`
      );
    }
    const realPath = realpathSync(path);
    if (!isContainedPath(realAttemptDirectory, realPath)) {
      throw new Error(
        `Product Journey attempt evidence escaped its sandbox: ${path}`
      );
    }
    if (statistics.isDirectory()) {
      return listEvidenceFiles(attemptDirectory, path);
    }
    return statistics.isFile() ? [path] : [];
  });
}

function linkAttemptEvidence(
  aggregateDirectory: string,
  attemptDirectory: string,
  attempt: number,
  writeEvent: ReturnType<typeof makeRunEventWriter>
) {
  recordReliableAttemptEvidence({
    aggregateDirectory,
    attemptDirectory,
    attempt,
    evidencePaths: listEvidenceFiles(attemptDirectory).filter(
      (path) => basename(path) !== OWNERSHIP_MARKER_NAME
    ),
    writeEvent,
  });
}

function adoptOwnedAttemptSandbox(options: {
  runRoot: string;
  aggregateDirectory: string;
  ownedSandboxDirectory: string;
  attemptDirectory: string;
  attempt: number;
  ownershipToken: string;
  writeEvent: ReturnType<typeof makeRunEventWriter>;
}) {
  const identityBefore = verifyOwnedAttemptSandbox(
    options.runRoot,
    options.ownedSandboxDirectory,
    options.ownedSandboxDirectory,
    options.ownershipToken
  );
  renameSync(options.ownedSandboxDirectory, options.attemptDirectory);
  try {
    const identityAfter = verifyOwnedAttemptSandbox(
      options.aggregateDirectory,
      options.attemptDirectory,
      options.ownedSandboxDirectory,
      options.ownershipToken
    );
    if (
      identityBefore.device !== identityAfter.device ||
      identityBefore.inode !== identityAfter.inode
    ) {
      throw new Error(
        'Product Journey owned sandbox identity changed during adoption'
      );
    }
    linkAttemptEvidence(
      options.aggregateDirectory,
      options.attemptDirectory,
      options.attempt,
      options.writeEvent
    );
  } catch (cause) {
    cleanupOwnedSandbox(options.attemptDirectory, options.ownershipToken);
    throw cause;
  }
}

async function startAttempt(
  attempt: number,
  resultPath: string,
  ownedSandboxDirectory: string,
  ownershipToken: string,
  forwardedArguments: readonly string[]
): Promise<AttemptProcess> {
  const attemptRunnerPath =
    process.env.OGI_PACKAGED_ATTEMPT_RUNNER ??
    join(import.meta.dir, 'run-packaged-handoff.ts');
  const torrentInstallation = forwardedArguments.includes(
    '--deterministic-torrent-installation'
  );
  let command = process.execPath;
  let commandArguments = [attemptRunnerPath, '--pin', ...forwardedArguments];
  const environment = {
    ...process.env,
    OGI_PACKAGED_ATTEMPT_RESULT: resultPath,
    OGI_PACKAGED_ATTEMPT_SANDBOX: ownedSandboxDirectory,
    OGI_PACKAGED_ATTEMPT_OWNERSHIP_TOKEN: ownershipToken,
    OGI_SCENARIO_ATTEMPT: String(attempt),
  };
  if (torrentInstallation && process.platform === 'linux') {
    const require = createRequire(import.meta.url);
    const electronVersion = (
      require('electron/package.json') as { version: string }
    ).version;
    const electronMajorMinor = electronVersion.split('.').slice(0, 2).join('.');
    const chromiumVersions = require('electron-to-chromium/versions') as Record<
      string,
      string
    >;
    const browserMajor = chromiumVersions[electronMajorMinor];
    if (!browserMajor) {
      throw new Error(
        `Chromium version is unknown for Electron ${electronVersion}`
      );
    }
    const chromedriverPath = resolveOfflineChromedriverPath({
      environment,
      platform: process.platform,
      browserMajor,
    });
    if (!chromedriverPath) {
      throw new Error(
        'Deterministic torrent Product Journey requires a pre-cached Chromedriver'
      );
    }
    Object.assign(environment, {
      OGI_CHROMEDRIVER_PATH: chromedriverPath,
    });
    command = 'bwrap';
    commandArguments = [
      '--unshare-net',
      '--die-with-parent',
      '--dev-bind',
      '/',
      '/',
      '--proc',
      '/proc',
      '--',
      process.execPath,
      attemptRunnerPath,
      '--pin',
      ...forwardedArguments,
    ];
    Object.assign(environment, {
      OGI_TORRENT_NETWORK_ISOLATION: 'linux-bwrap',
      OGI_TORRENT_PARENT_NETWORK_NAMESPACE: readlinkSync('/proc/self/ns/net'),
    });
  } else if (torrentInstallation && process.platform === 'win32') {
    const require = createRequire(import.meta.url);
    const electronPath = require('electron') as string;
    command = 'powershell.exe';
    commandArguments = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(import.meta.dir, 'windows-torrent-network-isolation.ps1'),
      process.execPath,
      electronPath,
      attemptRunnerPath,
      '--pin',
      ...forwardedArguments,
    ];
    Object.assign(environment, {
      OGI_TORRENT_NETWORK_ISOLATION: 'windows-firewall-program-scope',
      OGI_TORRENT_WINDOWS_ISOLATION_EVIDENCE: join(
        ownedSandboxDirectory,
        'artifacts/windows-torrent-network-isolation.json'
      ),
    });
  }
  const { child, tracker } = await spawnTrackedProcess(
    command,
    commandArguments,
    {
      detached: process.platform === 'linux',
      stdio: 'inherit',
      env: environment,
    }
  );
  if (!child.pid)
    throw new Error('Product Journey attempt worker did not start');
  const completion = new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveAttempt, rejectAttempt) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveAttempt({ status: child.exitCode, signal: child.signalCode });
      return;
    }
    const onError = (cause: Error) => rejectAttempt(cause);
    const onExit = (status: number | null, signal: NodeJS.Signals | null) => {
      child.off('error', onError);
      resolveAttempt({ status, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return { child, tracker, completion };
}

validateScenarioSourceDispositions([
  process.env.OGI_E2E_SCENARIO_SOURCE_PATH ??
    join(import.meta.dir, '../specs/packaged-handoff.ts'),
]);

const forwardedArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== '--pin');
const pinRequested = process.argv.includes('--pin');
const aggregateRunId = randomUUID();
const runRoot = getDefaultRunRoot();
mkdirSync(runRoot, { recursive: true });
const aggregateDirectory = mkdtempSync(
  join(runRoot, `product-journey-reliable-${aggregateRunId}-`)
);
const eventLogPath = join(aggregateDirectory, 'events.jsonl');
const startedAt = new Date().toISOString();
const scenarioId = 'reliable-product-journey';
let writeEvent = makeRunEventWriter(eventLogPath, aggregateRunId);
writeEvent(
  { type: 'run.started', payload: { platform: process.platform } },
  startedAt
);
writeEvent({
  type: 'scenario.started',
  payload: { scenarioId, kind: 'Product Journey' },
});
writeEvent({
  type: 'attempt.started',
  payload: { scenarioId, attempt: 1 },
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
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);

const attempts: AttemptOutcome[] = [];
let infrastructureDetail = '';
for (let attempt = 1; attempt <= 2; attempt++) {
  const resultPath = join(aggregateDirectory, `attempt-${attempt}-result.json`);
  const ownedSandboxDirectory = join(
    runRoot,
    `product-journey-${aggregateRunId}-attempt-${attempt}`
  );
  const ownershipToken = randomUUID();
  let attemptProcess: AttemptProcess;
  try {
    attemptProcess = await startAttempt(
      attempt,
      resultPath,
      ownedSandboxDirectory,
      ownershipToken,
      forwardedArguments
    );
  } catch (cause) {
    attempts.push(
      cancellationRequested ? 'Cancelled' : 'Infrastructure Failed'
    );
    infrastructureDetail =
      cause instanceof Error ? cause.message : String(cause);
    writeEvent({
      type: 'attempt.completed',
      payload: { attempt, outcome: attempts.at(-1)! },
    });
    break;
  }
  writeEvent({
    type: 'process.started',
    payload: {
      pid: attemptProcess.child.pid!,
      name: `Product Journey attempt ${attempt} worker`,
    },
  });

  let processResult:
    | { status: number | null; signal: NodeJS.Signals | null }
    | undefined;
  let processFailure: unknown;
  try {
    const completion = await Promise.race([
      attemptProcess.completion.then((result) => ({
        kind: 'process' as const,
        result,
      })),
      cancellation.then(() => ({ kind: 'cancelled' as const })),
    ]);
    if (completion.kind === 'process') processResult = completion.result;
  } catch (cause) {
    processFailure = cause;
  }

  let unexpectedSurvivors: number[] = [];
  if (!cancellationRequested && processResult) {
    try {
      unexpectedSurvivors = await findTrackedProcessSurvivors(
        attemptProcess.tracker,
        [attemptProcess.child.pid!]
      );
    } catch (cause) {
      processFailure = cause;
    }
  }
  const cleanupExit = await Effect.runPromiseExit(
    terminateProcessTree(attemptProcess.child, attemptProcess.tracker)
  );
  const cleanupFailed = Exit.isFailure(cleanupExit);
  const leaked = !cancellationRequested && unexpectedSurvivors.length > 0;
  writeEvent({
    type: 'process.stopped',
    payload: {
      pid: attemptProcess.child.pid!,
      leaked: leaked || cleanupFailed,
    },
  });

  if (cancellationRequested) {
    let evidenceFailure: unknown;
    try {
      const announcedResult = await awaitAttemptResult(
        resultPath,
        ownedSandboxDirectory
      );
      if (
        announcedResult &&
        resolve(announcedResult.sandboxDirectory) !==
          resolve(ownedSandboxDirectory)
      ) {
        throw new Error(
          `Product Journey attempt ${attempt} announced an unowned sandbox`
        );
      }
      const ownershipDeadline = Date.now() + 500;
      while (
        !existsSync(ownedSandboxDirectory) &&
        Date.now() < ownershipDeadline
      ) {
        await Bun.sleep(25);
      }
      if (!existsSync(ownedSandboxDirectory)) {
        throw new Error(
          `Owned Product Journey attempt ${attempt} sandbox was not established`
        );
      }
      const attemptDirectory = join(aggregateDirectory, `attempt-${attempt}`);
      adoptOwnedAttemptSandbox({
        runRoot,
        aggregateDirectory,
        ownedSandboxDirectory,
        attemptDirectory,
        attempt,
        ownershipToken,
        writeEvent,
      });
    } catch (cause) {
      cleanupOwnedSandbox(ownedSandboxDirectory, ownershipToken);
      evidenceFailure = cause;
    }
    const attemptOutcome: AttemptOutcome =
      cleanupFailed || evidenceFailure ? 'Infrastructure Failed' : 'Cancelled';
    attempts.push(attemptOutcome);
    if (cleanupFailed) {
      infrastructureDetail = 'Cancelled Product Journey cleanup failed';
    } else if (evidenceFailure) {
      infrastructureDetail = `Cancelled Product Journey evidence adoption failed: ${
        evidenceFailure instanceof Error
          ? evidenceFailure.message
          : String(evidenceFailure)
      }`;
    }
    writeEvent({
      type: 'attempt.completed',
      payload: { attempt, outcome: attemptOutcome },
    });
    break;
  }
  const infrastructureFailures: string[] = [];
  if (processFailure) {
    infrastructureFailures.push(
      processFailure instanceof Error
        ? processFailure.message
        : String(processFailure)
    );
  }
  if (cleanupFailed) {
    infrastructureFailures.push(
      'Product Journey attempt worker cleanup failed'
    );
  }
  if (unexpectedSurvivors.length > 0) {
    infrastructureFailures.push(
      `Unexpected surviving attempt worker processes: ${unexpectedSurvivors.join(', ')}`
    );
  }

  const resultRead = readAttemptResult(resultPath, ownedSandboxDirectory);
  if (resultRead.kind === 'missing') {
    infrastructureFailures.push(
      `Product Journey attempt ${attempt} exited with status ${processResult?.status} and signal ${processResult?.signal} without a typed result`
    );
  } else if (resultRead.kind === 'invalid') {
    infrastructureFailures.push(resultRead.error.message);
  }

  const attemptDirectory = join(aggregateDirectory, `attempt-${attempt}`);
  try {
    if (!existsSync(ownedSandboxDirectory)) {
      throw new Error(
        `Owned Product Journey attempt ${attempt} sandbox was not established`
      );
    }
    adoptOwnedAttemptSandbox({
      runRoot,
      aggregateDirectory,
      ownedSandboxDirectory,
      attemptDirectory,
      attempt,
      ownershipToken,
      writeEvent,
    });
  } catch (cause) {
    cleanupOwnedSandbox(ownedSandboxDirectory, ownershipToken);
    infrastructureFailures.push(
      cause instanceof Error ? cause.message : String(cause)
    );
  }

  const result = resultRead.kind === 'valid' ? resultRead.result : undefined;
  if (result) {
    const unexpectedCompletion = getUnexpectedAttemptCompletion(
      result,
      processResult
    );
    if (unexpectedCompletion) infrastructureFailures.push(unexpectedCompletion);
  }

  if (infrastructureFailures.length > 0 || !result) {
    attempts.push('Infrastructure Failed');
    infrastructureDetail = infrastructureFailures.join('; ');
    writeEvent({
      type: 'attempt.completed',
      payload: { attempt, outcome: 'Infrastructure Failed' },
    });
    break;
  }

  attempts.push(result.outcome);
  writeEvent({
    type: 'attempt.completed',
    payload: { attempt, outcome: result.outcome },
  });

  if (attempt === 1 && result.outcome === 'Failed') {
    writeEvent({
      type: 'retry.scheduled',
      payload: {
        scenarioId,
        fromAttempt: 1,
        toAttempt: 2,
        reason: result.failure || 'Product Journey assertion failed',
      },
    });
    writeEvent({
      type: 'attempt.started',
      payload: { scenarioId, attempt: 2 },
    });
    continue;
  }
  break;
}

const outcome: TerminalOutcome = classifyRunOutcome(attempts);
const requiredCheck = getRequiredCheckResult(outcome);
const shouldRetain = pinRequested || outcome !== 'Passed';
const reliabilityReportPath = join(aggregateDirectory, 'reliability.json');
const htmlReportPath = join(aggregateDirectory, 'report.html');
writeFileSync(
  reliabilityReportPath,
  JSON.stringify(
    {
      version: 1,
      runId: aggregateRunId,
      outcome,
      attempts,
      attemptArtifacts: readReliableAttemptEvidenceSummary(eventLogPath),
      requiredCheck,
      retained: shouldRetain,
      ...(infrastructureDetail ? { infrastructureDetail } : {}),
    },
    null,
    2
  )
);
writeEvent({
  type: 'artifact.created',
  payload: {
    artifactType: 'reliability-report',
    path: relative(aggregateDirectory, reliabilityReportPath),
  },
});
if (shouldRetain) {
  finalizeRunRetention({
    runId: aggregateRunId,
    sandboxDirectory: aggregateDirectory,
    outcome,
    createdAt: startedAt,
    pinned: pinRequested,
  });
  writeEvent({
    type: 'artifact.created',
    payload: { artifactType: 'retention-manifest', path: 'retention.json' },
  });
}
writeFileSync(htmlReportPath, renderRunHtmlReport(eventLogPath, outcome));
writeEvent({
  type: 'artifact.created',
  payload: { artifactType: 'html-report', path: 'report.html' },
});
writeEvent({
  type: 'scenario.completed',
  payload: { scenarioId, outcome },
});
writeEvent({ type: 'run.completed', payload: { outcome } });
writeFileSync(
  join(aggregateDirectory, 'summary.json'),
  JSON.stringify(replayRunEventLog(eventLogPath), null, 2)
);
writeFileSync(htmlReportPath, renderRunHtmlReport(eventLogPath, outcome));
console.log(`Run Event Log: ${eventLogPath}`);
console.log(`Scenario Sandbox: ${aggregateDirectory}`);
console.log(
  `Required check: ${requiredCheck.passed ? 'Passed' : 'Failed'} (${outcome})`
);
if (!shouldRetain) {
  finalizeRunRetention({
    runId: aggregateRunId,
    sandboxDirectory: aggregateDirectory,
    outcome,
    createdAt: startedAt,
  });
  console.log('Scenario Sandbox deleted by successful-run retention policy');
}
if (shouldApplyRunRetention(process.env)) {
  applyRunRetention(getDefaultRunRoot());
}
process.off('SIGINT', cancel);
process.off('SIGTERM', cancel);
process.exitCode = requiredCheck.exitCode;
