import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Effect } from 'effect';
import {
  findTrackedProcessSurvivors,
  spawnTrackedProcess,
  terminateProcessTree,
} from './process-tree';
import { validateScenarioDisposition } from './run-reliability';

export type QuarantineRegistration = {
  id: string;
  sourcePath: string;
  issue: string;
  owner: string;
  expires: string;
  command: string[];
  expectedOutcome: 'Failed';
  expectedFailure: {
    assertionId: string;
    signature: string;
  };
  timeoutMs?: number;
};

type QuarantineMatrixOutcome =
  | 'Expected Failure'
  | 'Unexpected Pass'
  | 'Unexpected Behavior'
  | 'Missing Outcome Evidence'
  | 'Malformed Outcome Evidence'
  | 'Unrelated Assertion Failure'
  | 'Flaky'
  | 'Infrastructure Failed'
  | 'Leaked Process'
  | 'Timed Out'
  | 'Signalled';

export type QuarantineScenarioResult = {
  id: string;
  outcome: QuarantineMatrixOutcome;
  status: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  dequarantineRequired: boolean;
  evidenceDirectory: string;
  processEvidencePath: string;
};

export type QuarantineWindowsJobEvidence = {
  version: 1;
  rootPid: number;
  survivingPids: number[];
  timedOut: boolean;
  killOnClose: true;
};

function requirePidArray(value: unknown, field: string) {
  if (
    !Array.isArray(value) ||
    value.some((pid) => !Number.isInteger(pid) || Number(pid) < 1)
  ) {
    throw new Error(`Windows quarantine Job Object ${field} is invalid`);
  }
  return [...new Set(value.map(Number))];
}

export function parseQuarantineWindowsJobEvidence(
  input: unknown
): QuarantineWindowsJobEvidence {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Windows quarantine Job Object evidence must be an object');
  }
  const record = input as Record<string, unknown>;
  const survivingPids = requirePidArray(
    record.survivingPids,
    'survivor evidence'
  );
  if (
    record.version !== 1 ||
    survivingPids.length !== (record.survivingPids as unknown[]).length ||
    !Number.isInteger(record.rootPid) ||
    Number(record.rootPid) < 1 ||
    typeof record.timedOut !== 'boolean'
  ) {
    throw new Error('Windows quarantine Job Object evidence is invalid');
  }
  if (record.killOnClose !== true) {
    throw new Error(
      'Windows quarantine Job Object kill-on-close proof is invalid'
    );
  }
  return {
    version: 1,
    rootPid: Number(record.rootPid),
    survivingPids,
    timedOut: record.timedOut,
    killOnClose: true,
  };
}

export function classifyQuarantineProcessOutcome({
  survivorsBeforeCleanup,
  survivorsAfterCleanup,
  timedOut,
  cleanupError,
  reportContainedSurvivorsBeforeTimeout = true,
}: {
  survivorsBeforeCleanup: readonly number[];
  survivorsAfterCleanup: readonly number[];
  timedOut: boolean;
  cleanupError?: unknown;
  reportContainedSurvivorsBeforeTimeout?: boolean;
}): QuarantineMatrixOutcome | undefined {
  if (survivorsAfterCleanup.length > 0) return 'Leaked Process';
  if (
    reportContainedSurvivorsBeforeTimeout &&
    survivorsBeforeCleanup.length > 0
  ) {
    return 'Leaked Process';
  }
  if (cleanupError) return 'Infrastructure Failed';
  if (timedOut) return 'Timed Out';
  if (survivorsBeforeCleanup.length > 0) return 'Leaked Process';
  return undefined;
}

export function getQuarantineCommandLaunch(
  platform: NodeJS.Platform,
  command: readonly string[],
  windowsJobResultPath: string,
  timeoutMs: number
) {
  const [executable, ...arguments_] = command;
  if (!executable) throw new Error('Quarantine command is empty');
  if (platform !== 'win32') {
    return {
      command: executable,
      args: arguments_,
      detached: false,
      environment: {},
    };
  }
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve(import.meta.dir, '../../updater/src/windows-job-wrapper.ps1'),
      executable,
      ...arguments_,
    ],
    detached: false,
    environment: {
      OGI_WINDOWS_JOB_RESULT: windowsJobResultPath,
      OGI_WINDOWS_JOB_TIMEOUT_MS: String(timeoutMs),
    },
  };
}

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Quarantine ${field} is missing or invalid`);
  }
  return value;
}

export function loadQuarantineRegistry(
  registryPath: string,
  now = new Date()
): QuarantineRegistration[] {
  const value: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(value))
    throw new Error('Quarantine registry must be an array');
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new Error(`Quarantine registration ${index + 1} is not an object`);
    }
    const record = candidate as Record<string, unknown>;
    const id = requireString(record.id, 'id');
    if (ids.has(id)) throw new Error(`Duplicate quarantine id: ${id}`);
    ids.add(id);
    const issue = requireString(record.issue, 'issue');
    const owner = requireString(record.owner, 'owner');
    const expires = requireString(record.expires, 'expires');
    validateScenarioDisposition(
      {
        scenarioId: id,
        skip: true,
        quarantine: { issue, owner, expires },
      },
      now
    );
    const configuredSourcePath = requireString(record.sourcePath, 'sourcePath');
    const sourcePath = isAbsolute(configuredSourcePath)
      ? resolve(configuredSourcePath)
      : resolve(dirname(registryPath), configuredSourcePath);
    if (!existsSync(sourcePath)) {
      throw new Error(`Quarantine source does not exist: ${sourcePath}`);
    }
    const annotation = `@quarantine id=${id} issue=${issue} owner=${owner} expires=${expires}`;
    if (!readFileSync(sourcePath, 'utf8').includes(annotation)) {
      throw new Error(
        `Quarantine ${id} registry metadata does not match source annotation`
      );
    }
    if (
      !Array.isArray(record.command) ||
      record.command.length === 0 ||
      record.command.some(
        (part) => typeof part !== 'string' || part.length === 0
      )
    ) {
      throw new Error(`Quarantine ${id} command is missing or invalid`);
    }
    if (record.expectedOutcome !== 'Failed') {
      throw new Error(
        `Quarantine ${id} expectedOutcome must currently be Failed`
      );
    }
    if (
      typeof record.expectedFailure !== 'object' ||
      record.expectedFailure === null
    ) {
      throw new Error(`Quarantine ${id} expectedFailure is missing or invalid`);
    }
    const expectedFailureRecord = record.expectedFailure as Record<
      string,
      unknown
    >;
    const expectedFailure = {
      assertionId: requireString(
        expectedFailureRecord.assertionId,
        `${id} expectedFailure assertionId`
      ),
      signature: requireString(
        expectedFailureRecord.signature,
        `${id} expectedFailure signature`
      ),
    };
    if (
      record.timeoutMs !== undefined &&
      (!Number.isInteger(record.timeoutMs) ||
        Number(record.timeoutMs) < 1 ||
        Number(record.timeoutMs) > 600_000)
    ) {
      throw new Error(`Quarantine ${id} timeoutMs is invalid`);
    }
    return {
      id,
      sourcePath,
      issue,
      owner,
      expires,
      command: record.command as string[],
      expectedOutcome: 'Failed',
      expectedFailure,
      ...(record.timeoutMs === undefined
        ? {}
        : { timeoutMs: Number(record.timeoutMs) }),
    };
  });
}

type TypedQuarantineEvidence = {
  version: 1;
  outcome: 'Failed' | 'Flaky' | 'Infrastructure Failed';
  assertion?: { id: string; signature: string };
  leakedProcesses?: number[];
};

function readTypedOutcomeEvidence(
  path: string
):
  | { kind: 'missing' }
  | { kind: 'malformed'; raw?: unknown }
  | { kind: 'valid'; value: TypedQuarantineEvidence } {
  if (!existsSync(path)) return { kind: 'missing' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'malformed' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'malformed', raw };
  }
  const record = raw as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !['Failed', 'Flaky', 'Infrastructure Failed'].includes(
      String(record.outcome)
    ) ||
    (record.leakedProcesses !== undefined &&
      (!Array.isArray(record.leakedProcesses) ||
        record.leakedProcesses.some(
          (pid) => !Number.isInteger(pid) || Number(pid) < 1
        )))
  ) {
    return { kind: 'malformed', raw };
  }
  if (record.outcome === 'Failed') {
    if (typeof record.assertion !== 'object' || record.assertion === null) {
      return { kind: 'malformed', raw };
    }
    const assertion = record.assertion as Record<string, unknown>;
    if (
      typeof assertion.id !== 'string' ||
      assertion.id.length === 0 ||
      typeof assertion.signature !== 'string' ||
      assertion.signature.length === 0
    ) {
      return { kind: 'malformed', raw };
    }
  }
  return { kind: 'valid', value: raw as TypedQuarantineEvidence };
}

async function waitForQuarantineCommand(
  child: ChildProcess,
  timeoutMs: number
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: Error;
}> {
  return await new Promise((resolveExecution) => {
    let settled = false;
    const finish = (
      status: number | null,
      signal: NodeJS.Signals | null,
      timedOut: boolean,
      error?: Error
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExecution({
        status,
        signal,
        timedOut,
        ...(error ? { error } : {}),
      });
    };
    const timer = setTimeout(
      () => finish(child.exitCode, child.signalCode, true),
      timeoutMs
    );
    child.once('exit', (status, signal) => finish(status, signal, false));
    child.once('error', (error) => finish(null, null, false, error));
  });
}

export async function runQuarantinedScenarioMatrix(
  registrations: readonly QuarantineRegistration[],
  outputDirectory: string
) {
  mkdirSync(outputDirectory, { recursive: true });
  const scenarios: QuarantineScenarioResult[] = [];
  for (const registration of registrations) {
    const evidenceDirectory = join(outputDirectory, registration.id);
    mkdirSync(evidenceDirectory, { recursive: true });
    const startedAt = Date.now();
    const outcomeEvidencePath = join(evidenceDirectory, 'outcome.json');
    const processEvidencePath = join(
      evidenceDirectory,
      'process-evidence.json'
    );
    const timeoutMs = registration.timeoutMs ?? 300_000;
    const windowsJobResultPath = join(
      evidenceDirectory,
      'windows-job-result.json'
    );
    const launch = getQuarantineCommandLaunch(
      process.platform,
      registration.command,
      windowsJobResultPath,
      timeoutMs
    );
    const { child, tracker } = await Effect.runPromise(
      spawnTrackedProcess(launch.command, launch.args, {
        cwd: resolve(import.meta.dir, '../..'),
        detached: launch.detached,
        env: {
          ...process.env,
          ...launch.environment,
          OGI_E2E_FORCE_QUARANTINE: registration.id,
          OGI_E2E_QUARANTINE_EVIDENCE_DIRECTORY: evidenceDirectory,
          OGI_E2E_QUARANTINE_RESULT_PATH: outcomeEvidencePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    const execution = await waitForQuarantineCommand(
      child,
      process.platform === 'win32' ? timeoutMs + 10_000 : timeoutMs
    );
    let windowsJobEvidence: QuarantineWindowsJobEvidence | undefined;
    let survivorsBeforeCleanup: number[] = [];
    let cleanupError: unknown;
    if (process.platform === 'win32') {
      try {
        if (!existsSync(windowsJobResultPath)) {
          throw new Error('Windows quarantine Job Object evidence is missing');
        }
        windowsJobEvidence = parseQuarantineWindowsJobEvidence(
          JSON.parse(readFileSync(windowsJobResultPath, 'utf8')) as unknown
        );
        survivorsBeforeCleanup = windowsJobEvidence.survivingPids;
      } catch (cause) {
        cleanupError = cause;
      }
    } else {
      try {
        survivorsBeforeCleanup = await Effect.runPromise(
          findTrackedProcessSurvivors(tracker, child.pid ? [child.pid] : [])
        );
      } catch (cause) {
        cleanupError = cause;
      }
    }
    try {
      await Effect.runPromise(terminateProcessTree(child, tracker));
    } catch (cause) {
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, cause], 'Quarantine cleanup failed')
        : cause;
    }
    let survivorsAfterCleanup: number[] = [];
    try {
      survivorsAfterCleanup = await Effect.runPromise(
        findTrackedProcessSurvivors(tracker)
      );
    } catch (cause) {
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, cause], 'Quarantine cleanup failed')
        : cause;
    }
    const trackedPids = windowsJobEvidence
      ? windowsJobEvidence.survivingPids
      : tracker
        ? [...tracker.tracked.keys()]
        : [];
    const timedOut =
      execution.timedOut || windowsJobEvidence?.timedOut === true;
    writeFileSync(
      processEvidencePath,
      `${JSON.stringify(
        {
          version: 1,
          rootPid: child.pid ?? null,
          trackedPids,
          survivorsBeforeCleanup,
          survivorsAfterCleanup,
          timedOut,
          ...(windowsJobEvidence
            ? {
                windowsJobResultPath,
                windowsJobEvidence,
              }
            : {}),
          ...(cleanupError
            ? {
                cleanupError:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              }
            : {}),
        },
        null,
        2
      )}\n`
    );
    const elapsedMs = Date.now() - startedAt;
    writeFileSync(
      join(evidenceDirectory, 'stdout.log'),
      Buffer.concat(stdoutChunks)
    );
    writeFileSync(
      join(evidenceDirectory, 'stderr.log'),
      Buffer.concat(stderrChunks)
    );
    const typedEvidence = readTypedOutcomeEvidence(outcomeEvidencePath);
    let outcome: QuarantineMatrixOutcome;
    const processOutcome = classifyQuarantineProcessOutcome({
      survivorsBeforeCleanup,
      survivorsAfterCleanup,
      timedOut,
      cleanupError,
      reportContainedSurvivorsBeforeTimeout: process.platform === 'win32',
    });
    if (processOutcome) {
      outcome = processOutcome;
    } else if (execution.signal !== null) {
      outcome = 'Signalled';
    } else if (execution.status === 0) {
      outcome = 'Unexpected Pass';
    } else if (execution.status !== 1) {
      outcome = 'Unexpected Behavior';
    } else if (typedEvidence.kind === 'missing') {
      outcome = 'Missing Outcome Evidence';
    } else if (typedEvidence.kind === 'malformed') {
      outcome = 'Malformed Outcome Evidence';
    } else if (
      typedEvidence.value.leakedProcesses &&
      typedEvidence.value.leakedProcesses.length > 0
    ) {
      outcome = 'Leaked Process';
    } else if (typedEvidence.value.outcome === 'Flaky') {
      outcome = 'Flaky';
    } else if (typedEvidence.value.outcome === 'Infrastructure Failed') {
      outcome = 'Infrastructure Failed';
    } else if (
      typedEvidence.value.assertion?.id !==
        registration.expectedFailure.assertionId ||
      typedEvidence.value.assertion?.signature !==
        registration.expectedFailure.signature
    ) {
      outcome = 'Unrelated Assertion Failure';
    } else {
      outcome = 'Expected Failure';
    }
    const result: QuarantineScenarioResult = {
      id: registration.id,
      outcome,
      status: execution.status,
      signal: execution.signal,
      elapsedMs,
      dequarantineRequired: outcome === 'Unexpected Pass',
      evidenceDirectory,
      processEvidencePath,
    };
    writeFileSync(
      join(evidenceDirectory, 'result.json'),
      `${JSON.stringify(
        {
          version: 1,
          ...result,
          issue: registration.issue,
          owner: registration.owner,
          expires: registration.expires,
          expectedOutcome: registration.expectedOutcome,
          expectedFailure: registration.expectedFailure,
          typedOutcomeEvidence:
            typedEvidence.kind === 'valid'
              ? typedEvidence.value
              : typedEvidence.kind,
          processEvidence: {
            trackedPids,
            survivorsBeforeCleanup,
            survivorsAfterCleanup,
            ...(windowsJobEvidence
              ? {
                  windowsJobResultPath,
                  windowsJobEvidence,
                }
              : {}),
          },
          ...(execution.error
            ? { error: execution.error.message, timedOut }
            : {}),
          ...(cleanupError
            ? {
                cleanupError:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              }
            : {}),
        },
        null,
        2
      )}\n`
    );
    scenarios.push(result);
  }
  return {
    version: 1 as const,
    outcome: scenarios.every(
      (scenario) => scenario.outcome === 'Expected Failure'
    )
      ? ('Passed' as const)
      : ('Failed' as const),
    discovered: registrations.length,
    scenarios,
  };
}
