import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  classifyQuarantineProcessOutcome,
  getQuarantineCommandLaunch,
  loadQuarantineRegistry,
  parseQuarantineWindowsJobEvidence,
  runQuarantinedScenarioMatrix,
} from '../src/quarantined-scenarios';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'ogi-quarantine-test-'));
}

function writeRegistry(root: string, entries: unknown[]) {
  const path = join(root, 'quarantines.json');
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
  return path;
}

function writeSource(root: string, id: string, expires = '2026-08-01') {
  const path = join(root, `${id}.ts`);
  writeFileSync(
    path,
    `// @quarantine id=${id} issue=issues/${id}.md owner=e2e-owner expires=${expires}\n`
  );
  return path;
}

describe('nightly quarantined scenario execution', () => {
  test('constructs Windows quarantine commands through the Job Object wrapper', () => {
    expect(
      getQuarantineCommandLaunch(
        'win32',
        [
          'C:\\Program Files\\Bun\\bun.exe',
          'test',
          '--filter',
          'known failure',
        ],
        'C:\\evidence\\windows-job.json',
        12_345
      )
    ).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve(import.meta.dir, '../../updater/src/windows-job-wrapper.ps1'),
        'C:\\Program Files\\Bun\\bun.exe',
        'test',
        '--filter',
        'known failure',
      ],
      detached: false,
      environment: {
        OGI_WINDOWS_JOB_RESULT: 'C:\\evidence\\windows-job.json',
        OGI_WINDOWS_JOB_TIMEOUT_MS: '12345',
      },
    });
    expect(
      getQuarantineCommandLaunch(
        'linux',
        ['bun', 'test'],
        '/tmp/windows-job.json',
        1000
      )
    ).toEqual({
      command: 'bun',
      args: ['test'],
      detached: false,
      environment: {},
    });
  });

  test('parses simple Windows Job Object survivor evidence without relying on the root PID', () => {
    expect(
      parseQuarantineWindowsJobEvidence({
        version: 1,
        rootPid: 100,
        survivingPids: [201, 202],
        timedOut: true,
        killOnClose: true,
      })
    ).toEqual({
      version: 1,
      rootPid: 100,
      survivingPids: [201, 202],
      timedOut: true,
      killOnClose: true,
    });
    expect(() =>
      parseQuarantineWindowsJobEvidence({
        version: 1,
        rootPid: 100,
        survivingPids: [201],
        timedOut: false,
        killOnClose: false,
      })
    ).toThrow('kill-on-close');
  });

  test('classifies Windows Job Object descendants and malformed evidence before command status', () => {
    expect(
      classifyQuarantineProcessOutcome({
        survivorsBeforeCleanup: [201],
        survivorsAfterCleanup: [],
        timedOut: false,
      })
    ).toBe('Leaked Process');
    expect(
      classifyQuarantineProcessOutcome({
        survivorsBeforeCleanup: [],
        survivorsAfterCleanup: [],
        timedOut: false,
        cleanupError: new Error(
          'Windows quarantine Job Object evidence is missing'
        ),
      })
    ).toBe('Infrastructure Failed');
    expect(
      classifyQuarantineProcessOutcome({
        survivorsBeforeCleanup: [],
        survivorsAfterCleanup: [],
        timedOut: true,
      })
    ).toBe('Timed Out');
  });

  test('writes Windows survivor evidence only after closing the kill-on-close Job', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '../../updater/src/windows-job-wrapper.ps1'),
      'utf8'
    );
    const close = source.indexOf('CloseHandle(job);');
    const write = source.indexOf('WriteResult(', close);
    expect(source).toContain('OGI_WINDOWS_JOB_TIMEOUT_MS');
    expect(source).toContain('WaitTimeout');
    expect(source).toContain('JobObjectLimitKillOnJobClose');
    expect(source).toContain('survivingPids');
    expect(source).toContain('\\"version\\":1');
    expect(source).toContain('new uint[0]');
    expect(close).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(close);
  });

  test('discovers registered quarantine metadata and executes the mapped command', async () => {
    const root = makeRoot();
    const sourcePath = writeSource(root, 'known-failure');
    const registryPath = writeRegistry(root, [
      {
        id: 'known-failure',
        sourcePath,
        issue: 'issues/known-failure.md',
        owner: 'e2e-owner',
        expires: '2026-08-01',
        command: [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(process.env.OGI_E2E_QUARANTINE_RESULT_PATH, JSON.stringify({ version: 1, outcome: 'Failed', assertion: { id: 'registered-assertion', signature: 'expected signature' } })); process.exit(1)`,
        ],
        expectedOutcome: 'Failed',
        expectedFailure: {
          assertionId: 'registered-assertion',
          signature: 'expected signature',
        },
      },
    ]);
    const outputDirectory = join(root, 'output');

    const registry = loadQuarantineRegistry(
      registryPath,
      new Date('2026-07-25')
    );
    const report = await runQuarantinedScenarioMatrix(
      registry,
      outputDirectory
    );

    expect(report.outcome).toBe('Passed');
    expect(report.scenarios[0]?.outcome).toBe('Expected Failure');
    expect(
      readFileSync(join(outputDirectory, 'known-failure', 'stderr.log'), 'utf8')
    ).toBe('');
  });

  test('fails and surfaces an unexpected pass that should be dequarantined', async () => {
    const root = makeRoot();
    const sourcePath = writeSource(root, 'unexpected-pass');
    const registryPath = writeRegistry(root, [
      {
        id: 'unexpected-pass',
        sourcePath,
        issue: 'issues/unexpected-pass.md',
        owner: 'e2e-owner',
        expires: '2026-08-01',
        command: [process.execPath, '-e', 'process.exit(0)'],
        expectedOutcome: 'Failed',
        expectedFailure: {
          assertionId: 'registered-assertion',
          signature: 'expected signature',
        },
      },
    ]);

    const report = await runQuarantinedScenarioMatrix(
      loadQuarantineRegistry(registryPath, new Date('2026-07-25')),
      join(root, 'output')
    );
    expect(report.outcome).toBe('Failed');
    expect(report.scenarios[0]?.outcome).toBe('Unexpected Pass');
    expect(report.scenarios[0]?.dequarantineRequired).toBe(true);
  });

  test('fails unexpected command behavior and retains stdout, stderr, and typed outcome evidence', async () => {
    const root = makeRoot();
    const sourcePath = writeSource(root, 'unexpected-status');
    const registryPath = writeRegistry(root, [
      {
        id: 'unexpected-status',
        sourcePath,
        issue: 'issues/unexpected-status.md',
        owner: 'e2e-owner',
        expires: '2026-08-01',
        command: [
          process.execPath,
          '-e',
          "console.log('out'); console.error('err'); process.exit(2)",
        ],
        expectedOutcome: 'Failed',
        expectedFailure: {
          assertionId: 'registered-assertion',
          signature: 'expected signature',
        },
      },
    ]);
    const outputDirectory = join(root, 'output');

    const report = await runQuarantinedScenarioMatrix(
      loadQuarantineRegistry(registryPath, new Date('2026-07-25')),
      outputDirectory
    );
    expect(report.outcome).toBe('Failed');
    expect(report.scenarios[0]?.outcome).toBe('Unexpected Behavior');
    expect(
      readFileSync(
        join(outputDirectory, 'unexpected-status', 'stdout.log'),
        'utf8'
      )
    ).toContain('out');
    expect(
      JSON.parse(
        readFileSync(
          join(outputDirectory, 'unexpected-status', 'result.json'),
          'utf8'
        )
      ).status
    ).toBe(2);
  });

  test('distinguishes missing, malformed, unrelated, flaky, infrastructure, leak, timeout, and signal failures', async () => {
    const cases = [
      {
        id: 'missing-evidence',
        script: 'process.exit(1)',
        outcome: 'Missing Outcome Evidence',
      },
      {
        id: 'malformed-evidence',
        script: `require('node:fs').writeFileSync(process.env.OGI_E2E_QUARANTINE_RESULT_PATH, '{}'); process.exit(1)`,
        outcome: 'Malformed Outcome Evidence',
      },
      {
        id: 'unrelated-assertion',
        script: `require('node:fs').writeFileSync(process.env.OGI_E2E_QUARANTINE_RESULT_PATH, JSON.stringify({ version: 1, outcome: 'Failed', assertion: { id: 'other-assertion', signature: 'different failure' } })); process.exit(1)`,
        outcome: 'Unrelated Assertion Failure',
      },
      {
        id: 'flaky-outcome',
        script: `require('node:fs').writeFileSync(process.env.OGI_E2E_QUARANTINE_RESULT_PATH, JSON.stringify({ version: 1, outcome: 'Flaky' })); process.exit(1)`,
        outcome: 'Flaky',
      },
      {
        id: 'infrastructure-outcome',
        script: `require('node:fs').writeFileSync(process.env.OGI_E2E_QUARANTINE_RESULT_PATH, JSON.stringify({ version: 1, outcome: 'Infrastructure Failed' })); process.exit(1)`,
        outcome: 'Infrastructure Failed',
      },
      {
        id: 'leaked-process',
        script: `require('node:fs').writeFileSync(process.env.OGI_E2E_QUARANTINE_RESULT_PATH, JSON.stringify({ version: 1, outcome: 'Failed', assertion: { id: 'registered-assertion', signature: 'expected signature' }, leakedProcesses: [123] })); process.exit(1)`,
        outcome: 'Leaked Process',
      },
      {
        id: 'timeout',
        script: 'setInterval(() => {}, 1000)',
        outcome: 'Timed Out',
        timeoutMs: 20,
      },
      {
        id: 'signal',
        script: `process.kill(process.pid, 'SIGTERM')`,
        outcome: 'Signalled',
      },
    ] as const;
    for (const fixture of cases) {
      const root = makeRoot();
      const sourcePath = writeSource(root, fixture.id);
      const registryPath = writeRegistry(root, [
        {
          id: fixture.id,
          sourcePath,
          issue: `issues/${fixture.id}.md`,
          owner: 'e2e-owner',
          expires: '2026-08-01',
          command: [process.execPath, '-e', fixture.script],
          expectedOutcome: 'Failed',
          expectedFailure: {
            assertionId: 'registered-assertion',
            signature: 'expected signature',
          },
          ...('timeoutMs' in fixture ? { timeoutMs: fixture.timeoutMs } : {}),
        },
      ]);
      const report = await runQuarantinedScenarioMatrix(
        loadQuarantineRegistry(registryPath, new Date('2026-07-25')),
        join(root, 'output')
      );
      expect(report.outcome).toBe('Failed');
      expect(report.scenarios[0]?.outcome).toBe(fixture.outcome);
    }
  });

  test('contains and removes a detached quarantine descendant after timeout', async () => {
    if (process.platform === 'win32') return;
    const root = makeRoot();
    const childPidPath = join(root, 'detached-child.pid');
    const sourcePath = writeSource(root, 'detached-timeout');
    const registryPath = writeRegistry(root, [
      {
        id: 'detached-timeout',
        sourcePath,
        issue: 'issues/detached-timeout.md',
        owner: 'e2e-owner',
        expires: '2026-08-01',
        command: [
          process.execPath,
          '-e',
          `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); child.unref(); writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid)); setInterval(() => {}, 1000);`,
        ],
        expectedOutcome: 'Failed',
        expectedFailure: {
          assertionId: 'registered-assertion',
          signature: 'expected signature',
        },
        timeoutMs: 250,
      },
    ]);
    const outputDirectory = join(root, 'output');

    const report = await runQuarantinedScenarioMatrix(
      loadQuarantineRegistry(registryPath, new Date('2026-07-25')),
      outputDirectory
    );

    expect(report.scenarios[0]?.outcome).toBe('Timed Out');
    const detachedPid = Number(readFileSync(childPidPath, 'utf8'));
    expect(() => process.kill(detachedPid, 0)).toThrow();
    const processEvidencePath = join(
      outputDirectory,
      'detached-timeout',
      'process-evidence.json'
    );
    const processEvidence = JSON.parse(
      readFileSync(processEvidencePath, 'utf8')
    );
    expect(processEvidence).toMatchObject({
      version: 1,
      timedOut: true,
      survivorsAfterCleanup: [],
    });
    expect(processEvidence.trackedPids).toContain(detachedPid);
    expect(report.scenarios[0]?.processEvidencePath).toBe(processEvidencePath);
    expect(
      JSON.parse(
        readFileSync(
          join(outputDirectory, 'detached-timeout', 'result.json'),
          'utf8'
        )
      ).processEvidencePath
    ).toBe(processEvidencePath);
  });

  test('rejects expired, mismatched, duplicate, and missing-source registrations before execution', () => {
    const root = makeRoot();
    const expiredSource = writeSource(root, 'expired', '2026-07-24');
    const expired = writeRegistry(root, [
      {
        id: 'expired',
        sourcePath: expiredSource,
        issue: 'issues/expired.md',
        owner: 'e2e-owner',
        expires: '2026-07-24',
        command: [process.execPath, '-e', 'process.exit(1)'],
        expectedOutcome: 'Failed',
        expectedFailure: {
          assertionId: 'registered-assertion',
          signature: 'expected signature',
        },
      },
    ]);
    expect(() =>
      loadQuarantineRegistry(expired, new Date('2026-07-25'))
    ).toThrow('expired');

    const missing = writeRegistry(root, [
      {
        id: 'missing',
        sourcePath: join(root, 'missing.ts'),
        issue: 'issues/missing.md',
        owner: 'e2e-owner',
        expires: '2026-08-01',
        command: [process.execPath, '-e', 'process.exit(1)'],
        expectedOutcome: 'Failed',
        expectedFailure: {
          assertionId: 'registered-assertion',
          signature: 'expected signature',
        },
      },
    ]);
    expect(() =>
      loadQuarantineRegistry(missing, new Date('2026-07-25'))
    ).toThrow('source does not exist');

    const mismatchSource = writeSource(root, 'different');
    const mismatch = writeRegistry(root, [
      {
        id: 'mismatch',
        sourcePath: mismatchSource,
        issue: 'issues/mismatch.md',
        owner: 'e2e-owner',
        expires: '2026-08-01',
        command: [process.execPath, '-e', 'process.exit(1)'],
        expectedOutcome: 'Failed',
        expectedFailure: {
          assertionId: 'registered-assertion',
          signature: 'expected signature',
        },
      },
    ]);
    expect(() =>
      loadQuarantineRegistry(mismatch, new Date('2026-07-25'))
    ).toThrow('does not match source annotation');

    mkdirSync(join(root, 'duplicate'), { recursive: true });
    const duplicateSource = writeSource(join(root, 'duplicate'), 'duplicate');
    const duplicate = writeRegistry(root, [
      {
        id: 'duplicate',
        sourcePath: duplicateSource,
        issue: 'issues/duplicate.md',
        owner: 'e2e-owner',
        expires: '2026-08-01',
        command: [process.execPath, '-e', 'process.exit(1)'],
        expectedOutcome: 'Failed',
        expectedFailure: {
          assertionId: 'registered-assertion',
          signature: 'expected signature',
        },
      },
      {
        id: 'duplicate',
        sourcePath: duplicateSource,
        issue: 'issues/duplicate.md',
        owner: 'e2e-owner',
        expires: '2026-08-01',
        command: [process.execPath, '-e', 'process.exit(1)'],
        expectedOutcome: 'Failed',
        expectedFailure: {
          assertionId: 'registered-assertion',
          signature: 'expected signature',
        },
      },
    ]);
    expect(() =>
      loadQuarantineRegistry(duplicate, new Date('2026-07-25'))
    ).toThrow('Duplicate quarantine id');
  });
});
