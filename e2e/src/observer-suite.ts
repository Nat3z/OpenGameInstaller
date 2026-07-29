import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Effect, Exit } from 'effect';
import { ensureWorkspaceBuilds } from '../../scripts/ensure-workspace-builds';
import {
  type CiSuiteEntry,
  classifyCiCheckOutcome,
  collectTopLevelArtifactTypes,
  collectTopLevelRunOutcomes,
  evaluateRunEventLogBudgets,
  resolveObserverSelection,
} from './ci-gates';
import {
  findTrackedProcessSurvivors,
  type ProcessTreeTracker,
  spawnTrackedProcess,
  terminateProcessTree,
} from './process-tree';
import {
  makeRunEventWriter,
  type RunEvent,
  readRunEvents,
  renderRunHtmlReport,
  type TerminalOutcome,
} from './run-events';
import { finalizeRunRetention, getDefaultRunRoot } from './run-reliability';

type ObserverSuiteAnnouncement = {
  runId: string;
  sandboxDirectory: string;
  eventLogPath: string;
  events?: RunEvent[];
};

type ObserverSuiteOptions = {
  selectionId: string;
  entries?: readonly CiSuiteEntry[];
  runRoot?: string;
  announcementPath?: string;
  cancellationPath?: string;
  environment?: NodeJS.ProcessEnv;
  repositoryRoot?: string;
  pollIntervalMilliseconds?: number;
  skipWorkspacePreparation?: boolean;
};

function listEventLogs(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listEventLogs(path);
    return entry.isFile() && entry.name === 'events.jsonl' ? [path] : [];
  });
}

function topLevelEventLogs(runRoot: string) {
  return listEventLogs(runRoot).filter(
    (path) => relative(runRoot, path).split(/[\\/]/).length === 2
  );
}

function waitForExit(child: ChildProcess, timeoutMilliseconds = 5_000) {
  return new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ status: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveExit({ status: child.exitCode, signal: child.signalCode });
    }, timeoutMilliseconds);
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      resolveExit({ status, signal });
    });
  });
}

function announce(path: string | undefined, value: ObserverSuiteAnnouncement) {
  if (!path) return;
  writeFileSync(path, JSON.stringify(value));
}

function prefixedStepId(
  checkId: string,
  event: Extract<RunEvent, { type: 'step.started' | 'step.completed' }>
) {
  return `${checkId}:${event.runId}:${event.payload.stepId}`;
}

export async function runObserverSuite(options: ObserverSuiteOptions) {
  const entries =
    options.entries ?? resolveObserverSelection(options.selectionId);
  if (!entries || entries.length === 0) {
    throw new Error(
      `Unknown deterministic Observer selection: ${options.selectionId}`
    );
  }
  const environment = options.environment ?? process.env;
  const repositoryRoot =
    options.repositoryRoot ?? resolve(import.meta.dir, '../..');
  const runRoot = resolve(options.runRoot ?? getDefaultRunRoot());
  mkdirSync(runRoot, { recursive: true });
  const sandboxDirectory = mkdtempSync(join(runRoot, 'observer-suite-'));
  const childRunRoot = join(sandboxDirectory, 'runs');
  mkdirSync(childRunRoot, { recursive: true });
  const runId = randomUUID();
  const eventLogPath = join(sandboxDirectory, 'events.jsonl');
  writeFileSync(eventLogPath, '');
  const writeEvent = makeRunEventWriter(eventLogPath, runId);
  const startedAt = new Date().toISOString();
  writeEvent({ type: 'run.started', payload: { platform: process.platform } });
  announce(options.announcementPath, {
    runId,
    sandboxDirectory,
    eventLogPath,
  });

  const mirroredSequences = new Map<string, number>();
  const mirrorChildEvents = (checkId: string) => {
    for (const path of topLevelEventLogs(childRunRoot)) {
      const lastSequence = mirroredSequences.get(path) ?? 0;
      const events = readRunEvents(path);
      for (const event of events) {
        if (event.sequence <= lastSequence) continue;
        switch (event.type) {
          case 'step.started':
            writeEvent(
              {
                type: 'step.started',
                payload: {
                  stepId: prefixedStepId(checkId, event),
                  name: event.payload.name,
                },
              },
              event.timestamp
            );
            break;
          case 'step.completed':
            writeEvent(
              {
                type: 'step.completed',
                payload: {
                  ...event.payload,
                  stepId: prefixedStepId(checkId, event),
                },
              },
              event.timestamp
            );
            break;
          case 'artifact.created': {
            const childSandbox = resolve(path, '..');
            const absoluteArtifact = resolve(childSandbox, event.payload.path);
            const artifactPath = relative(sandboxDirectory, absoluteArtifact);
            if (
              artifactPath === '..' ||
              artifactPath.startsWith(
                `..${process.platform === 'win32' ? '\\' : '/'}`
              ) ||
              !existsSync(absoluteArtifact)
            ) {
              break;
            }
            writeEvent(
              {
                type: 'artifact.created',
                payload: {
                  ...event.payload,
                  path: artifactPath.replaceAll('\\', '/'),
                  ...(event.payload.stepId
                    ? {
                        stepId: `${checkId}:${event.runId}:${event.payload.stepId}`,
                      }
                    : {}),
                },
              },
              event.timestamp
            );
            break;
          }
          default:
            break;
        }
        mirroredSequences.set(path, event.sequence);
      }
    }
  };

  let cancelled = false;
  let failed = false;
  if (!options.skipWorkspacePreparation) {
    try {
      ensureWorkspaceBuilds();
    } catch (cause) {
      failed = true;
      process.stderr.write(
        `Observer suite workspace preparation failed: ${cause instanceof Error ? cause.message : String(cause)}\n`
      );
    }
  }

  for (const entry of failed ? [] : entries) {
    const scenarioId = `observer-check:${entry.id}`;
    const wrapperStepId = `observer-check:${entry.id}:execution`;
    writeEvent({
      type: 'scenario.started',
      payload: { scenarioId, kind: 'Deterministic Suite Check' },
    });
    writeEvent({
      type: 'attempt.started',
      payload: { scenarioId, attempt: 1 },
    });
    writeEvent({
      type: 'step.started',
      payload: { stepId: wrapperStepId, name: entry.name },
    });

    const existingLogs = new Set(topLevelEventLogs(childRunRoot));
    const [command, ...args] = entry.command;
    if (!command) throw new Error(`Observer check ${entry.id} has no command`);
    let child: ChildProcess | undefined;
    let tracker: ProcessTreeTracker | undefined;
    let timedOut = false;
    let status: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let cleanupFailed = false;
    let unexpectedSurvivors: number[] = [];
    try {
      const launched = await spawnTrackedProcess(command, args, {
        cwd: repositoryRoot,
        detached: process.platform !== 'win32',
        env: {
          ...environment,
          OGI_E2E_RUN_ROOT: childRunRoot,
          OGI_E2E_DETERMINISTIC_ONLY: '1',
          OGI_OBSERVER_SESSION_RETENTION: '1',
          ...(process.platform === 'darwin'
            ? { OGI_DISABLE_EXECUTION_VIDEO: '1' }
            : {}),
        },
        stdio: 'inherit',
      });
      child = launched.child;
      tracker = launched.tracker;
      const deadline = Date.now() + (entry.timeoutMs ?? 25 * 60_000);
      while (child.exitCode === null && child.signalCode === null) {
        mirrorChildEvents(entry.id);
        if (options.cancellationPath && existsSync(options.cancellationPath)) {
          cancelled = true;
          break;
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        await delay(options.pollIntervalMilliseconds ?? 100);
      }
      if (cancelled || timedOut) {
        const cleanup = await Effect.runPromiseExit(
          terminateProcessTree(child, tracker)
        );
        cleanupFailed = Exit.isFailure(cleanup);
      }
      const processExit = await waitForExit(child);
      status = processExit.status;
      signal = processExit.signal;
      mirrorChildEvents(entry.id);
      if (!cancelled && !timedOut) {
        unexpectedSurvivors = await findTrackedProcessSurvivors(tracker, [
          child.pid!,
        ]);
        const cleanup = await Effect.runPromiseExit(
          terminateProcessTree(child, tracker)
        );
        cleanupFailed = Exit.isFailure(cleanup);
      }
    } catch (cause) {
      cleanupFailed = true;
      process.stderr.write(
        `Observer check ${entry.id} failed to execute: ${cause instanceof Error ? cause.message : String(cause)}\n`
      );
      if (child) {
        await Effect.runPromise(terminateProcessTree(child, tracker)).catch(
          () => undefined
        );
      }
    }

    const newLogs = topLevelEventLogs(childRunRoot).filter(
      (path) => !existingLogs.has(path)
    );
    const observedArtifacts = collectTopLevelArtifactTypes(
      childRunRoot,
      newLogs
    );
    const observedOutcomes = collectTopLevelRunOutcomes(childRunRoot, newLogs);
    let outcome: TerminalOutcome = cancelled
      ? 'Cancelled'
      : classifyCiCheckOutcome({
          status,
          timedOut,
          requiredArtifacts: entry.requiredArtifacts,
          observedArtifacts,
          observedOutcomes,
        });
    if (!cancelled) {
      for (const path of newLogs) {
        try {
          if (
            !evaluateRunEventLogBudgets(
              path,
              entry.id === 'golden-journey'
                ? 'golden-journey'
                : 'full-deterministic'
            ).passed
          ) {
            outcome = 'Failed';
          }
        } catch {
          outcome = 'Failed';
        }
      }
    }
    if (cleanupFailed || unexpectedSurvivors.length > 0) {
      outcome = 'Infrastructure Failed';
    }
    if (outcome !== 'Passed') failed = true;
    writeEvent({
      type: 'step.completed',
      payload: {
        stepId: wrapperStepId,
        outcome:
          outcome === 'Passed'
            ? 'Passed'
            : outcome === 'Cancelled'
              ? 'Cancelled'
              : 'Failed',
        ...(outcome === 'Passed'
          ? {}
          : {
              error: timedOut
                ? `${entry.name} timed out`
                : unexpectedSurvivors.length > 0
                  ? `Unexpected surviving processes: ${unexpectedSurvivors.join(', ')}`
                  : `${entry.name} ended as ${outcome}${signal ? ` (${signal})` : ''}`,
            }),
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
    if (cancelled) break;
  }

  const outcome: TerminalOutcome = cancelled
    ? 'Cancelled'
    : failed
      ? 'Failed'
      : 'Passed';
  const reliabilityPath = join(sandboxDirectory, 'reliability.json');
  const reportPath = join(sandboxDirectory, 'report.html');
  writeFileSync(
    reliabilityPath,
    `${JSON.stringify(
      {
        version: 1,
        runId,
        selectionId: options.selectionId,
        checks: entries.map((entry) => entry.id),
        outcome,
      },
      null,
      2
    )}\n`
  );
  writeEvent({
    type: 'artifact.created',
    payload: { artifactType: 'reliability-report', path: 'reliability.json' },
  });
  writeFileSync(reportPath, renderRunHtmlReport(eventLogPath, outcome));
  writeEvent({
    type: 'artifact.created',
    payload: { artifactType: 'html-report', path: 'report.html' },
  });
  writeEvent({ type: 'run.completed', payload: { outcome } });
  const sessionRetained = environment.OGI_OBSERVER_SESSION_RETENTION === '1';
  finalizeRunRetention({
    runId,
    sandboxDirectory,
    outcome,
    createdAt: startedAt,
    sessionRetained,
  });
  const events = existsSync(eventLogPath) ? readRunEvents(eventLogPath) : [];
  announce(options.announcementPath, {
    runId,
    sandboxDirectory,
    eventLogPath,
    events,
  });
  return { runId, sandboxDirectory, eventLogPath, outcome };
}
