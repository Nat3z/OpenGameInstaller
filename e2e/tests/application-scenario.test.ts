import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createApplicationScenarioSandbox,
  createUnavailableScreenshot,
  ensureApplicationFailureEvidence,
  getApplicationScenarioLaunch,
  parseApplicationRunDescriptor,
  parseApplicationScenarioMode,
  validateApplicationFailureEvidence,
  validateApplicationScenarioProcessOutcome,
} from '../src/application-scenario';

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

  test('strictly configures success and deliberate assertion-failure modes', () => {
    expect(parseApplicationScenarioMode([])).toBe('success');
    expect(parseApplicationScenarioMode(['--mode', 'assertion-failure'])).toBe(
      'assertion-failure'
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

  test('provides deterministic Linux and Windows WebdriverIO launch commands', () => {
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
        './src/windows-job-wrapper.ps1',
        'bunx',
        'wdio',
        'run',
        './application-scenario-wdio.conf.ts',
      ],
      detached: false,
    });
  });

  test('assigns the Windows launch to a kill-on-close Job Object before resume', () => {
    const wrapper = readFileSync(
      join(import.meta.dir, '../src/windows-job-wrapper.ps1'),
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
