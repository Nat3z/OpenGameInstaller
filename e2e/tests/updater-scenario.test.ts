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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcProcessIdentity } from '../src/process-tree';
import {
  createUpdaterScenarioSandbox as createSandbox,
  getUpdaterScenarioLaunch,
  parseUpdaterRunDescriptor,
  startFixtureService,
  writeUpdaterRunDescriptor,
} from '../src/updater-scenario';

const generatedSandboxes: string[] = [];
const createUpdaterScenarioSandbox: typeof createSandbox = (...args) => {
  const sandbox = createSandbox(...args);
  generatedSandboxes.push(sandbox.sandboxDirectory);
  return sandbox;
};
afterAll(() => {
  for (const sandbox of generatedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

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

  test('keeps an unconfirmed status-1 process failure infrastructural after an assertion step fails', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ogi-updater-mixed-failure-'));
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
        [join(import.meta.dir, '../src/run-updater-scenario.ts')],
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

  test('retains infrastructure failure while cleaning a tree that corrupts containment evidence', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ogi-updater-corrupt-evidence-'));
    const probePath = join(root, 'corrupt-evidence.ts');
    const pidsPath = join(root, 'contained-pids.json');
    writeFileSync(
      probePath,
      `import { spawn } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const detached = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
if (!detached.pid) throw new Error('detached child did not start');
detached.unref();
writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ target: process.pid, detached: detached.pid }));
const evidence = readdirSync(tmpdir())
  .filter((name) => name.startsWith('ogi-process-containment-') && name.endsWith('.json'))
  .map((name) => ({ path: join(tmpdir(), name), modified: statSync(join(tmpdir(), name)).mtimeMs }))
  .sort((left, right) => right.modified - left.modified)[0];
if (!evidence) throw new Error('containment evidence not found');
writeFileSync(evidence.path, '{corrupted');
await Bun.sleep(200);
`
    );

    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, '../src/run-updater-scenario.ts')],
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
      const sandboxName = readdirSync(root).find((name) =>
        name.startsWith('updater-')
      );
      expect(sandboxName).toBeTruthy();
      const sandbox = join(root, sandboxName!);
      expect(
        JSON.parse(
          readFileSync(join(sandbox, 'artifacts/reliability.json'), 'utf8')
        )
      ).toMatchObject({
        outcome: 'Infrastructure Failed',
        attempts: ['Infrastructure Failed'],
      });
      const events = readFileSync(join(sandbox, 'events.jsonl'), 'utf8');
      expect(events).toContain('"type":"process.stopped"');
      expect(events).not.toContain('retry.scheduled');
      const pids = JSON.parse(readFileSync(pidsPath, 'utf8')) as {
        target: number;
        detached: number;
      };
      for (const pid of [pids.target, pids.detached]) {
        expect([undefined, 'Z']).toContain(readProcProcessIdentity(pid)?.state);
      }
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('SIGINT and SIGTERM repeatedly cancel contained Updater trees across lifecycle races', async () => {
    if (process.platform === 'win32') return;
    const cases = [
      { signal: 'SIGTERM' as const, phase: 'active' },
      { signal: 'SIGINT' as const, phase: 'active' },
      { signal: 'SIGTERM' as const, phase: 'startup' },
      { signal: 'SIGINT' as const, phase: 'completion' },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), 'ogi-updater-cancel-'));
      const probePath = join(root, 'contained-probe.ts');
      const pidsPath = join(root, 'contained-pids.json');
      writeFileSync(
        probePath,
        `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const detached = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
if (!detached.pid) throw new Error('detached child did not start');
detached.unref();
writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ target: process.pid, detached: detached.pid }));
await Bun.sleep(${testCase.phase === 'completion' ? 200 : 30_000});
`
      );
      const runner = spawn(
        process.execPath,
        [join(import.meta.dir, '../src/run-updater-scenario.ts')],
        {
          env: {
            ...process.env,
            OGI_E2E_RUN_ROOT: root,
            OGI_E2E_RUNNER_PROBE_PATH: probePath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '';
      runner.stdout!.on('data', (chunk) => {
        stdout += String(chunk);
      });

      try {
        const deadline = Date.now() + 5_000;
        if (testCase.phase === 'startup') {
          while (
            !readdirSync(root).some((name) => name.startsWith('updater-')) &&
            Date.now() < deadline
          ) {
            await Bun.sleep(10);
          }
        } else {
          while (!existsSync(pidsPath) && Date.now() < deadline) {
            await Bun.sleep(10);
          }
          expect(existsSync(pidsPath)).toBe(true);
          if (testCase.phase === 'completion') await Bun.sleep(100);
        }
        runner.kill(testCase.signal);
        const status = await new Promise<number | null>((resolve, reject) => {
          runner.once('error', reject);
          runner.once('exit', resolve);
        });
        expect(status).toBe(1);
        expect(() => process.kill(runner.pid!, 0)).toThrow();

        const sandboxName = readdirSync(root).find((name) =>
          name.startsWith('updater-')
        );
        expect(sandboxName).toBeTruthy();
        const sandbox = join(root, sandboxName!);
        const reliability = JSON.parse(
          readFileSync(join(sandbox, 'artifacts/reliability.json'), 'utf8')
        );
        expect(reliability).toMatchObject({
          outcome: 'Cancelled',
          attempts: ['Cancelled'],
          retained: true,
        });
        const events = readFileSync(join(sandbox, 'events.jsonl'), 'utf8');
        expect(events).toContain('"outcome":"Cancelled"');
        expect(events).not.toContain('retry.scheduled');
        const supervisorPid = JSON.parse(
          events
            .split(/\r?\n/)
            .find((line) => line.includes('"type":"process.started"'))!
        ).payload.pid as number;
        expect([undefined, 'Z']).toContain(
          readProcProcessIdentity(supervisorPid)?.state
        );
        if (existsSync(pidsPath)) {
          const pids = JSON.parse(readFileSync(pidsPath, 'utf8')) as {
            target: number;
            detached: number;
          };
          for (const pid of [pids.target, pids.detached]) {
            expect([undefined, 'Z']).toContain(
              readProcProcessIdentity(pid)?.state
            );
          }
        }
        const report = readFileSync(join(sandbox, 'report.html'), 'utf8');
        const links = [...report.matchAll(/href="([^"]+)"/g)].map(
          (match) => match[1]!
        );
        expect(links.length).toBeGreaterThan(0);
        expect(
          links.filter((link) => !existsSync(join(sandbox, link)))
        ).toEqual([]);
        expect(stdout).toContain('Required check: Failed (Cancelled)');
      } finally {
        if (runner.exitCode === null) runner.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 45_000);

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
