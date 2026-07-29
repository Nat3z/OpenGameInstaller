import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createApplicationScenarioSandbox as createSandbox,
  createUnavailableScreenshot,
  ensureApplicationFailureEvidence,
  getApplicationScenarioLaunch,
  hasCompletedApplicationScenarioStep,
  parseApplicationRunDescriptor,
  parseApplicationScenarioMode,
  validateApplicationFailureEvidence,
  validateApplicationScenarioProcessOutcome,
} from '../src/application-scenario';
import type { RunEvent } from '../src/run-events';

const require = createRequire(import.meta.url);
const { validateAccessibilityRunDescriptor } =
  require('../src/application-run-descriptor.cjs') as {
    validateAccessibilityRunDescriptor(value: unknown): unknown;
  };

const generatedSandboxes: string[] = [];
const createApplicationScenarioSandbox: typeof createSandbox = (...args) => {
  const sandbox = createSandbox(...args);
  generatedSandboxes.push(sandbox.sandboxDirectory);
  return sandbox;
};
afterAll(() => {
  for (const sandbox of generatedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('Application Scenario sandbox', () => {
  test('creates fresh state wholly beneath its sandbox', () => {
    const first = createApplicationScenarioSandbox('run-one');
    const second = createApplicationScenarioSandbox('run-two');

    expect(first.sandboxDirectory).not.toBe(second.sandboxDirectory);
    expect(first.userDataDirectory.startsWith(first.sandboxDirectory)).toBe(
      true
    );
    expect(
      first.applicationStateDirectory.startsWith(first.sandboxDirectory)
    ).toBe(true);
    expect(
      existsSync(
        join(first.applicationStateDirectory, 'config/option/general.json')
      )
    ).toBe(true);
    expect(first.mode).toBe('success');
    expect(dirname(first.descriptorPath)).toBe(first.sandboxDirectory);
  });

  test('strictly validates accessibility Run Descriptors', () => {
    const sandboxDirectory = mkdtempSync(join(tmpdir(), 'ogi-accessibility-'));
    generatedSandboxes.push(sandboxDirectory);
    const descriptor = {
      version: 1,
      scenario: 'application-accessibility',
      state: 'main',
      sandboxDirectory,
    };

    expect(validateAccessibilityRunDescriptor(descriptor)).toEqual(descriptor);
    expect(() =>
      validateAccessibilityRunDescriptor({ ...descriptor, unexpected: true })
    ).toThrow('unknown fields');
    expect(() =>
      validateAccessibilityRunDescriptor({
        ...descriptor,
        sandboxDirectory: 'relative-sandbox',
      })
    ).toThrow('absolute path');
  });

  test('strictly configures success and deliberate assertion-failure modes', () => {
    expect(parseApplicationScenarioMode([])).toBe('success');
    expect(parseApplicationScenarioMode(['--mode', 'assertion-failure'])).toBe(
      'assertion-failure'
    );
    expect(parseApplicationScenarioMode(['--mode', 'flaky-once'])).toBe(
      'flaky-once'
    );
    expect(parseApplicationScenarioMode(['--mode', 'helper-leak'])).toBe(
      'helper-leak'
    );
    expect(() => parseApplicationScenarioMode(['--mode', 'unknown'])).toThrow(
      'mode'
    );
    expect(
      createApplicationScenarioSandbox('failure-run', 'assertion-failure').mode
    ).toBe('assertion-failure');
  });

  test('requires a decodable failure screenshot and populated product logs', async () => {
    const descriptor = createApplicationScenarioSandbox(
      'failure-evidence',
      'assertion-failure'
    );
    await expect(
      validateApplicationFailureEvidence(descriptor)
    ).rejects.toThrow('failure.png');

    writeFileSync(
      join(descriptor.artifactDirectory, 'failure.png'),
      'not a png'
    );
    await expect(
      validateApplicationFailureEvidence(descriptor)
    ).rejects.toThrow('failure.png');
    await createUnavailableScreenshot(
      join(descriptor.artifactDirectory, 'failure.png'),
      'test failure'
    );
    writeFileSync(
      join(descriptor.artifactDirectory, 'application-main.log'),
      `Application E2E fixture started ${descriptor.runId} assertion-failure`
    );
    writeFileSync(
      join(descriptor.artifactDirectory, 'application-renderer.log'),
      `Application E2E renderer ready: ${descriptor.runId}`
    );
    expect(await validateApplicationFailureEvidence(descriptor)).toEqual([
      'failure.png',
      'application-main.log',
      'application-renderer.log',
    ]);
  });

  test('validates evidence for ordinary scenario failures', async () => {
    const descriptor = createApplicationScenarioSandbox('ordinary-failure');
    await createUnavailableScreenshot(
      join(descriptor.artifactDirectory, 'failure.png'),
      'ordinary failure'
    );
    writeFileSync(
      join(descriptor.artifactDirectory, 'application-main.log'),
      `Application E2E fixture started ${descriptor.runId} success`
    );
    writeFileSync(
      join(descriptor.artifactDirectory, 'application-renderer.log'),
      `Application E2E renderer ready: ${descriptor.runId}`
    );

    expect(await validateApplicationFailureEvidence(descriptor)).toEqual([
      'failure.png',
      'application-main.log',
      'application-renderer.log',
    ]);
  });

  test('rejects a PNG with a valid header but truncated image data', async () => {
    const descriptor = createApplicationScenarioSandbox('truncated-png');
    const screenshotPath = join(descriptor.artifactDirectory, 'failure.png');
    await createUnavailableScreenshot(screenshotPath, 'truncated image');
    const screenshot = readFileSync(screenshotPath);
    writeFileSync(
      screenshotPath,
      screenshot.subarray(0, screenshot.length - 12)
    );
    writeFileSync(
      join(descriptor.artifactDirectory, 'application-main.log'),
      'main diagnostics'
    );
    writeFileSync(
      join(descriptor.artifactDirectory, 'application-renderer.log'),
      'renderer diagnostics'
    );

    await expect(
      validateApplicationFailureEvidence(descriptor)
    ).rejects.toThrow('failure.png');
  });

  test('creates fallback evidence for adversarial diagnostic text', async () => {
    const descriptor = createApplicationScenarioSandbox('escaped-diagnostic');

    expect(
      await ensureApplicationFailureEvidence(
        descriptor,
        `${'a'.repeat(156)}&\u0000`
      )
    ).toEqual([
      'failure.png',
      'application-main.log',
      'application-renderer.log',
    ]);
  });

  test('requires completed observable step evidence before passing', () => {
    expect(hasCompletedApplicationScenarioStep([])).toBe(false);
    expect(
      hasCompletedApplicationScenarioStep([
        {
          version: 1,
          runId: 'step-evidence',
          sequence: 1,
          timestamp: '2026-07-29T00:00:00.000Z',
          type: 'step.completed',
          payload: { stepId: 'navigate-discovery', outcome: 'Passed' },
        } satisfies RunEvent,
      ])
    ).toBe(true);
  });

  test('requires assertion-failure mode to produce a failed process outcome', () => {
    expect(() =>
      validateApplicationScenarioProcessOutcome('assertion-failure', false)
    ).toThrow('unexpectedly exited successfully');
    expect(
      validateApplicationScenarioProcessOutcome('assertion-failure', true)
    ).toBeUndefined();
    expect(
      validateApplicationScenarioProcessOutcome('success', false)
    ).toBeUndefined();
  });

  test('provides deterministic WebdriverIO launch commands', () => {
    expect(getApplicationScenarioLaunch('linux')).toEqual({
      command: 'xvfb-run',
      args: [
        '-a',
        'bunx',
        'wdio',
        'run',
        './application-scenario-wdio.conf.ts',
      ],
      detached: true,
    });
    expect(getApplicationScenarioLaunch('win32')).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        '../updater/src/windows-job-wrapper.ps1',
        'bunx',
        'wdio',
        'run',
        './application-scenario-wdio.conf.ts',
      ],
      detached: false,
    });
    expect(getApplicationScenarioLaunch('darwin', '/electron')).toEqual({
      command: '/electron',
      args: [
        '-e',
        "import('@wdio/cli').then(({ run }) => run())",
        '--',
        'run',
        './application-scenario-wdio.conf.ts',
      ],
      detached: true,
    });
  });

  test.skipIf(process.platform !== 'darwin')(
    'tracks an Application Scenario process tree on macOS',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'ogi-application-darwin-'));
      const probePath = join(root, 'probe.ts');
      writeFileSync(probePath, 'await Bun.sleep(250);');

      try {
        const result = spawnSync(
          process.execPath,
          [join(import.meta.dir, '../src/run-application-scenario.ts')],
          {
            env: {
              ...process.env,
              OGI_E2E_RUN_ROOT: root,
              OGI_E2E_RUNNER_PROBE_PATH: probePath,
            },
            encoding: 'utf8',
            timeout: 30_000,
          }
        );
        expect(`${result.stdout}${result.stderr}`).not.toContain(
          'Could not track the process tree'
        );
        expect(result.status).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  test('assigns the Windows launch to a kill-on-close Job Object before resume', () => {
    const wrapper = readFileSync(
      resolve(import.meta.dir, '../../updater/src/windows-job-wrapper.ps1'),
      'utf8'
    );
    expect(wrapper).toContain('JobObjectLimitKillOnJobClose');
    expect(
      wrapper.indexOf('AssignProcessToJobObject(job, process.hProcess)')
    ).toBeLessThan(wrapper.indexOf('ResumeThread(process.hThread)'));
    expect(wrapper).toContain(
      'startup.StartupInfo.dwFlags = StartfUseStdHandles'
    );
    expect(wrapper).toContain('DuplicateStandardHandle(StdOutputHandle)');
    expect(wrapper).toContain('ProcThreadAttributeHandleList');
    expect(wrapper).toContain('OGI_WINDOWS_JOB_RESULT');
    expect(wrapper.lastIndexOf('WriteResult(')).toBeLessThan(
      wrapper.indexOf('if (job != IntPtr.Zero) CloseHandle(job)')
    );
  });

  test('classifies an immediate detached root-exit orphan as infrastructure failure and removes it', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ogi-application-runner-leak-'));
    const probePath = join(root, 'root-exit-orphan.ts');
    const pidPath = join(root, 'orphan.pid');
    writeFileSync(
      probePath,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
if (!orphan.pid) throw new Error('orphan did not start');
orphan.unref();
writeFileSync(${JSON.stringify(pidPath)}, String(orphan.pid));
await Bun.sleep(100);
`
    );

    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, '../src/run-application-scenario.ts')],
        {
          env: {
            ...process.env,
            OGI_E2E_RUN_ROOT: root,
            OGI_E2E_RUNNER_PROBE_PATH: probePath,
          },
          encoding: 'utf8',
          timeout: 30_000,
        }
      );
      expect(result.status).toBe(1);
      const sandboxDirectory = result.stdout
        .match(/Scenario Sandbox: (.+)/)?.[1]
        ?.trim();
      expect(sandboxDirectory).toBeTruthy();
      expect(
        JSON.parse(
          readFileSync(
            join(sandboxDirectory!, 'artifacts/reliability.json'),
            'utf8'
          )
        )
      ).toMatchObject({
        outcome: 'Infrastructure Failed',
        attempts: ['Infrastructure Failed'],
      });
      const events = readFileSync(
        join(sandboxDirectory!, 'events.jsonl'),
        'utf8'
      );
      expect(events).toMatch(/"type":"process.stopped".*"leaked":true/);
      expect(events).not.toContain('retry.scheduled');
      const orphanPid = Number(readFileSync(pidPath, 'utf8'));
      expect(() => process.kill(orphanPid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports a failed runner before contained child cleanup', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ogi-application-runner-failed-'));
    const probePath = join(root, 'failed-with-child.ts');
    const pidPath = join(root, 'child.pid');
    writeFileSync(
      probePath,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
if (!child.pid) throw new Error('child did not start');
child.unref();
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
await Bun.sleep(100);
process.exit(1);
`
    );

    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, '../src/run-application-scenario.ts')],
        {
          env: {
            ...process.env,
            OGI_E2E_RUN_ROOT: root,
            OGI_E2E_RUNNER_PROBE_PATH: probePath,
          },
          encoding: 'utf8',
          timeout: 30_000,
        }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exited with status 1');
      expect(result.stderr).not.toContain(
        'Unexpected surviving product processes'
      );
      const childPid = Number(readFileSync(pidPath, 'utf8'));
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps an unconfirmed status-1 process failure infrastructural after an assertion step fails', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ogi-application-mixed-failure-'));
    const probePath = join(root, 'assertion-then-crash.ts');
    writeFileSync(
      probePath,
      `import { readFileSync } from 'node:fs';
import { makeRunEventWriter, replayRunEventLog } from ${JSON.stringify(join(import.meta.dir, '../src/run-events.ts'))};
const descriptor = JSON.parse(readFileSync(process.env.OGI_RUN_DESCRIPTOR!, 'utf8'));
const writeEvent = makeRunEventWriter(descriptor.eventLogPath, descriptor.runId, replayRunEventLog(descriptor.eventLogPath).lastSequence);
writeEvent({ type: 'step.started', payload: { stepId: 'mixed-failure', name: 'Fail assertion before crash' } });
writeEvent({ type: 'step.completed', payload: { stepId: 'mixed-failure', outcome: 'Failed', error: 'assertion failed first' } });
process.exit(1);
`
    );

    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, '../src/run-application-scenario.ts')],
        {
          env: {
            ...process.env,
            OGI_E2E_RUN_ROOT: root,
            OGI_E2E_RUNNER_PROBE_PATH: probePath,
          },
          encoding: 'utf8',
          timeout: 30_000,
        }
      );
      expect(result.status).toBe(1);
      const sandboxDirectory = result.stdout
        .match(/Scenario Sandbox: (.+)/)?.[1]
        ?.trim();
      expect(sandboxDirectory).toBeTruthy();
      expect(
        JSON.parse(
          readFileSync(
            join(sandboxDirectory!, 'artifacts/reliability.json'),
            'utf8'
          )
        )
      ).toMatchObject({
        outcome: 'Infrastructure Failed',
        attempts: ['Infrastructure Failed'],
      });
      expect(
        readFileSync(join(sandboxDirectory!, 'events.jsonl'), 'utf8')
      ).not.toContain('retry.scheduled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not retry a cancelled Application Scenario', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-application-runner-cancel-'));
    const probePath = join(root, 'long-running-probe.ts');
    const startedPath = join(root, 'started');
    writeFileSync(
      probePath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(startedPath)}, 'started'); await Bun.sleep(30_000);`
    );
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, '../src/run-application-scenario.ts')],
      {
        env: {
          ...process.env,
          OGI_E2E_RUN_ROOT: root,
          OGI_E2E_RUNNER_PROBE_PATH: probePath,
        },
        stdio: 'ignore',
      }
    );

    try {
      const deadline = Date.now() + 3_000;
      while (!existsSync(startedPath) && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(existsSync(startedPath)).toBe(true);
      child.kill('SIGTERM');
      const status = await new Promise<number | null>((resolveExit) =>
        child.once('exit', resolveExit)
      );
      expect(status).toBe(1);
      const sandboxName = readdirSync(root).find((name) =>
        name.startsWith('application-')
      );
      expect(sandboxName).toBeTruthy();
      const events = readFileSync(
        join(root, sandboxName!, 'events.jsonl'),
        'utf8'
      );
      expect(events).toContain('"outcome":"Cancelled"');
      expect(events).not.toContain('retry.scheduled');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects unknown fields and paths escaping the sandbox', () => {
    expect(() =>
      parseApplicationRunDescriptor({
        version: 1,
        scenario: 'application-visible-navigation',
        runId: 'run-one',
        sandboxDirectory: '/tmp/sandbox',
        applicationStateDirectory: '/tmp/outside',
        userDataDirectory: '/tmp/sandbox/user-data',
        artifactDirectory: '/tmp/sandbox/artifacts',
        eventLogPath: '/tmp/sandbox/events.jsonl',
        unexpected: true,
      })
    ).toThrow('unknown fields');
  });
});
