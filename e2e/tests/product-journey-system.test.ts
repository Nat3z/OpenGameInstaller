import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import {
  completeProductJourneyAutomation,
  disconnectProductJourneyBrowser,
  getProductJourneyLaunch,
  signalProductJourneyCompletion,
  summarizeProductJourneyProcessFailure,
} from '../src/packaged-handoff';
import {
  findTrackedProcessSurvivors,
  spawnTrackedProcess,
  terminateProcessTree,
} from '../src/process-tree';
import { makeRunEventWriter } from '../src/run-events';
import {
  readReliableAttemptEvidenceSummary,
  recordReliableAttemptEvidence,
  shouldApplyRunRetention,
} from '../src/run-reliability';

describe('Product Journey system integration', () => {
  test('uses the native WebdriverIO CLI host on macOS without execution video', () => {
    expect(
      getProductJourneyLaunch({
        hostPlatform: 'darwin',
        electronExecutable: '/electron',
      })
    ).toEqual({
      command: '/electron',
      args: [
        '-e',
        "import('@wdio/cli').then(({ run }) => run())",
        '--',
        'run',
        './product-journey-wdio.conf.ts',
      ],
      detached: true,
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  test('keeps the supervisor launch detail with the process exit failure', () => {
    const detail = summarizeProductJourneyProcessFailure(
      { status: 127, signal: null, _tag: 'ProductJourneyProcessExitError' },
      new Error(
        'macOS launch containment failed: target launch failed: No such file or directory'
      )
    );

    expect(detail).toContain('status 127');
    expect(detail).toContain('target launch failed');
  });

  test.skipIf(process.platform === 'win32')(
    'labels missing supervised commands for the current POSIX host',
    async () => {
      const launched = await spawnTrackedProcess(
        `ogi-command-that-does-not-exist-${process.pid}`,
        [],
        { stdio: 'ignore' }
      );
      await new Promise<void>((resolve) =>
        launched.child.once('exit', () => resolve())
      );

      try {
        await expect(
          findTrackedProcessSurvivors(launched.tracker, [launched.child.pid!])
        ).rejects.toThrow(
          process.platform === 'darwin'
            ? /macOS launch containment failed: target launch failed/
            : /Linux launch containment failed: target launch failed/
        );
      } finally {
        await Effect.runPromise(
          terminateProcessTree(launched.child, launched.tracker)
        ).catch(() => undefined);
      }
    }
  );

  test('disconnects automation without asking Electron to close itself', async () => {
    let disconnected = 0;
    let closed = 0;
    await disconnectProductJourneyBrowser({
      disconnect: async () => {
        disconnected += 1;
      },
      close: async () => {
        closed += 1;
      },
    });

    expect(disconnected).toBe(1);
    expect(closed).toBe(0);
  });

  test('disconnects automation before signaling product shutdown', async () => {
    const fixtureStateDirectory = mkdtempSync(
      join(tmpdir(), 'ogi-journey-order-')
    );
    const completionPath = join(fixtureStateDirectory, 'journey-complete.json');
    let disconnected = false;

    await completeProductJourneyAutomation(
      {
        disconnect: () => {
          expect(existsSync(completionPath)).toBe(false);
          disconnected = true;
        },
      },
      fixtureStateDirectory
    );

    expect(disconnected).toBe(true);
    expect(existsSync(completionPath)).toBe(true);
  });

  test('signals the updater to close product windows after assertions', () => {
    const fixtureStateDirectory = mkdtempSync(
      join(tmpdir(), 'ogi-journey-complete-')
    );

    const completionPath = signalProductJourneyCompletion(
      fixtureStateDirectory
    );

    expect(completionPath).toBe(
      join(fixtureStateDirectory, 'journey-complete.json')
    );
    expect(JSON.parse(readFileSync(completionPath, 'utf8'))).toEqual({
      version: 1,
      completed: true,
    });
  });

  test('defers global retention cleanup during an Observer session', () => {
    expect(shouldApplyRunRetention({})).toBe(true);
    expect(
      shouldApplyRunRetention({ OGI_OBSERVER_SESSION_RETENTION: '1' })
    ).toBe(false);
  });

  test('uses handle-bound identity outside Linux procfs hosts', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../updater/e2e-product-journey-main.cjs'),
      'utf8'
    );

    expect(source).toContain("if (process.platform === 'linux') {");
    expect(source).toContain("if (process.platform !== 'linux') {");
    expect(source).toContain(': process.execPath;');
    expect(source).toContain(': spawn(process.execPath, electronArgs, {');
    expect(source).toContain(
      'async function stopApplicationAfterJourneyCompletion(window, updaterStatus)'
    );
    expect(source).toContain('await stopCandidateApplication();');
    expect(source).toContain('void stopApplicationAfterJourneyCompletion(');
    expect(source).toContain('window.hide();');
    expect(source).not.toContain('window.close();');
  });

  test('publishes real screenshots without treating build images as screenshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-reliable-artifacts-'));
    const attemptDirectory = join(root, 'attempt-1');
    const artifactDirectory = join(attemptDirectory, 'artifacts');
    const buildDirectory = join(artifactDirectory, 'builds/linux/app/renderer');
    const storageDirectory = join(
      attemptDirectory,
      'application-user-data/Session Storage'
    );
    mkdirSync(buildDirectory, { recursive: true });
    mkdirSync(storageDirectory, { recursive: true });
    const screenshotPath = join(artifactDirectory, 'failure.png');
    const buildImagePath = join(buildDirectory, 'favicon.png');
    const storageLogPath = join(storageDirectory, '000003.log');
    writeFileSync(screenshotPath, 'screenshot');
    writeFileSync(buildImagePath, 'build image');
    writeFileSync(storageLogPath, 'browser storage');
    const eventLogPath = join(root, 'events.jsonl');
    const writeEvent = makeRunEventWriter(eventLogPath, 'reliable-run');

    recordReliableAttemptEvidence({
      aggregateDirectory: root,
      attemptDirectory,
      attempt: 1,
      evidencePaths: [screenshotPath, buildImagePath, storageLogPath],
      writeEvent,
    });

    expect(readReliableAttemptEvidenceSummary(eventLogPath)).toEqual([
      {
        attempt: 1,
        artifactType: 'screenshot',
        path: 'attempt-1/artifacts/failure.png',
      },
    ]);
  });
});
