import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createUpdaterScenarioSandbox,
  getUpdaterScenarioLaunch,
  parseUpdaterRunDescriptor,
  startFixtureService,
  writeUpdaterRunDescriptor,
} from '../src/updater-scenario';

describe('Updater Scenario', () => {
  test('creates fresh state wholly beneath its Scenario Sandbox', () => {
    const first = createUpdaterScenarioSandbox('updater-one');
    const second = createUpdaterScenarioSandbox('updater-two');

    expect(first.sandboxDirectory).not.toBe(second.sandboxDirectory);
    expect(first.userDataDirectory.startsWith(first.sandboxDirectory)).toBe(
      true
    );
    expect(first.installationDirectory.startsWith(first.sandboxDirectory)).toBe(
      true
    );
    expect(first.fixtureStateDirectory.startsWith(first.sandboxDirectory)).toBe(
      true
    );
    expect(existsSync(first.artifactDirectory)).toBe(true);
  });

  test('strictly rejects unknown fields, escaping paths, and non-loopback endpoints', () => {
    const layout = createUpdaterScenarioSandbox('strict-descriptor');
    const { descriptorPath: _descriptorPath, ...descriptorLayout } = layout;
    const base = {
      version: 1,
      scenario: 'updater-fixture-release',
      ...descriptorLayout,
      fixtureBaseUrl: 'http://127.0.0.1:4567',
      releaseApiUrl:
        'http://127.0.0.1:4567/repos/Nat3z/OpenGameInstaller/releases',
      nativeDialogResponses: [{ action: 'choose-stable-channel', response: 0 }],
    };

    expect(() =>
      parseUpdaterRunDescriptor({ ...base, unexpected: true })
    ).toThrow('unknown fields');
    expect(() =>
      parseUpdaterRunDescriptor({
        ...base,
        artifactDirectory: '/tmp/outside-updater-sandbox',
      })
    ).toThrow('escapes the Scenario Sandbox');
    expect(() =>
      parseUpdaterRunDescriptor({
        ...base,
        fixtureBaseUrl: 'https://api.github.com',
        releaseApiUrl:
          'https://api.github.com/repos/Nat3z/OpenGameInstaller/releases',
      })
    ).toThrow('loopback');
  });

  test('serves deterministic release metadata on an allocated loopback port and records requests', async () => {
    const layout = createUpdaterScenarioSandbox('fixture-service');
    const fixture = await startFixtureService(layout.fixtureStateDirectory);
    try {
      expect(fixture.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(
        `${fixture.baseUrl}/repos/Nat3z/OpenGameInstaller/releases`
      );
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual([
        expect.objectContaining({ tag_name: 'v9.9.9', prerelease: false }),
      ]);
      const requests = readFileSync(fixture.requestLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(requests).toEqual([
        expect.objectContaining({
          method: 'GET',
          path: '/repos/Nat3z/OpenGameInstaller/releases',
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  test('writes a validated descriptor with a queued native-dialog response', async () => {
    const layout = createUpdaterScenarioSandbox('descriptor-write');
    const fixture = await startFixtureService(layout.fixtureStateDirectory);
    try {
      const descriptor = writeUpdaterRunDescriptor(layout, fixture.baseUrl);
      expect(descriptor.nativeDialogResponses).toEqual([
        { action: 'choose-stable-channel', response: 0 },
      ]);
      expect(
        parseUpdaterRunDescriptor(
          JSON.parse(readFileSync(descriptor.descriptorPath, 'utf8'))
        )
      ).toEqual(
        expect.objectContaining({
          runId: descriptor.runId,
          fixtureBaseUrl: descriptor.fixtureBaseUrl,
          nativeDialogResponses: descriptor.nativeDialogResponses,
        })
      );
      expect(descriptor.releaseApiUrl.startsWith(fixture.baseUrl)).toBe(true);
      expect(descriptor.nativeDialogLogPath).toBe(
        join(layout.artifactDirectory, 'native-dialog-requests.jsonl')
      );
    } finally {
      await fixture.close();
    }
  });

  test('provides contained Linux and Windows WebdriverIO launch commands', () => {
    expect(getUpdaterScenarioLaunch('linux')).toEqual({
      command: 'xvfb-run',
      args: ['-a', 'bunx', 'wdio', 'run', './updater-scenario-wdio.conf.ts'],
      detached: true,
    });
    expect(getUpdaterScenarioLaunch('win32')).toEqual({
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
        './updater-scenario-wdio.conf.ts',
      ],
      detached: false,
    });
  });
});
