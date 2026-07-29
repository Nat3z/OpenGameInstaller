import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CiSuiteEntry } from '../src/ci-gates';
import { reduceObserverEvents } from '../src/observer-state';
import { runObserverSuite } from '../src/observer-suite';
import { readRunEvents } from '../src/run-events';

const generatedDirectories: string[] = [];
afterAll(() => {
  for (const directory of generatedDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const fixturePath = join(import.meta.dir, 'fixtures/observer-suite-check.ts');

function entry(id: string, behavior: 'pass' | 'fail' | 'wait'): CiSuiteEntry {
  return {
    id,
    name: `Check ${id}`,
    command: [process.execPath, fixturePath, id, behavior],
    kind: 'deterministic',
    timeoutMs: 10_000,
  };
}

function createRunRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ogi-observer-suite-test-'));
  generatedDirectories.push(root);
  return root;
}

describe.serial('Observer deterministic suite runner', () => {
  test('aggregates multiple checks, child steps, and artifacts', async () => {
    const runRoot = createRunRoot();
    const result = await runObserverSuite({
      selectionId: 'fixture-preset',
      entries: [entry('first', 'pass'), entry('second', 'pass')],
      runRoot,
      environment: {
        ...process.env,
        OGI_OBSERVER_SESSION_RETENTION: '1',
      },
      repositoryRoot: resolve(import.meta.dir, '../..'),
      pollIntervalMilliseconds: 10,
      skipWorkspacePreparation: true,
    });

    expect(result.outcome).toBe('Passed');
    const events = readRunEvents(result.eventLogPath);
    const state = reduceObserverEvents(events);
    expect(state.scenarios.map((scenario) => scenario.id)).toEqual([
      'observer-check:first',
      'observer-check:second',
    ]);
    expect(
      state.scenarios.flatMap((scenario) =>
        scenario.steps.map((step) => step.name)
      )
    ).toEqual([
      'Check first',
      'Execute first',
      'Check second',
      'Execute second',
    ]);
    const childArtifacts = events.filter(
      (event) =>
        event.type === 'artifact.created' &&
        event.payload.path.startsWith('runs/')
    );
    expect(childArtifacts).toHaveLength(2);
    for (const artifact of childArtifacts) {
      if (artifact.type !== 'artifact.created') continue;
      expect(
        existsSync(join(result.sandboxDirectory, artifact.payload.path))
      ).toBe(true);
    }
  });

  test('keeps running checks after a failure and reports the aggregate failure', async () => {
    const result = await runObserverSuite({
      selectionId: 'fixture-failure',
      entries: [entry('failed', 'fail'), entry('after-failure', 'pass')],
      runRoot: createRunRoot(),
      environment: {
        ...process.env,
        OGI_OBSERVER_SESSION_RETENTION: '1',
      },
      repositoryRoot: resolve(import.meta.dir, '../..'),
      pollIntervalMilliseconds: 10,
      skipWorkspacePreparation: true,
    });

    expect(result.outcome).toBe('Failed');
    expect(
      reduceObserverEvents(readRunEvents(result.eventLogPath)).scenarios.map(
        (scenario) => [scenario.id, scenario.outcome]
      )
    ).toEqual([
      ['observer-check:failed', 'Failed'],
      ['observer-check:after-failure', 'Passed'],
    ]);
  });

  test('cancels the active check and terminates its process tree', async () => {
    const runRoot = createRunRoot();
    const cancellationPath = join(runRoot, 'cancel');
    const running = runObserverSuite({
      selectionId: 'fixture-cancel',
      entries: [entry('waiting', 'wait')],
      runRoot,
      cancellationPath,
      environment: {
        ...process.env,
        OGI_OBSERVER_SESSION_RETENTION: '1',
      },
      repositoryRoot: resolve(import.meta.dir, '../..'),
      pollIntervalMilliseconds: 10,
      skipWorkspacePreparation: true,
    });
    await Bun.sleep(250);
    writeFileSync(cancellationPath, 'cancel');
    const result = await running;

    expect(result.outcome).toBe('Cancelled');
    expect(
      reduceObserverEvents(readRunEvents(result.eventLogPath)).status
    ).toBe('Cancelled');
  }, 30_000);
});
