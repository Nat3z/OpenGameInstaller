import { describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  computeWorkspaceBuildFingerprint,
  ensureWorkspaceBuilds,
  lockOwnerIsAlive,
  runWorkspacePackageBuild,
  WORKSPACE_BUILD_OUTPUTS,
  WorkspaceBuildTimeoutError,
  type WorkspacePackageName,
} from '../../scripts/ensure-workspace-builds';

function createWorkspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ogi-workspace-builds-'));
  mkdirSync(join(root, 'packages/ogi-addon/src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(root, 'bun.lock'), 'lockfile-v1\n');
  writeFileSync(
    join(root, 'packages/ogi-addon/package.json'),
    '{"name":"ogi-addon"}\n'
  );
  writeFileSync(
    join(root, 'packages/ogi-addon/src/main.ts'),
    'export const version = 1;\n'
  );
  return root;
}

function createOutputs(
  root: string,
  packageNames: readonly WorkspacePackageName[],
  content = 'generated\n'
) {
  for (const packageName of packageNames) {
    for (const output of WORKSPACE_BUILD_OUTPUTS[packageName]) {
      const path = join(root, output);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
}

function waitForProcess(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Child process exited with status ${code}`));
    });
  });
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe('workspace build prerequisites', () => {
  test('rebuilds stale inputs and skips unchanged fingerprints', () => {
    const root = createWorkspaceFixture();
    const packages: WorkspacePackageName[] = ['ogi-addon'];
    let buildCount = 0;
    const runBuild = (packageNames: readonly WorkspacePackageName[]) => {
      buildCount += 1;
      createOutputs(root, packageNames);
    };

    expect(ensureWorkspaceBuilds(packages, { root, runBuild })).toBe(true);
    expect(ensureWorkspaceBuilds(packages, { root, runBuild })).toBe(false);
    expect(buildCount).toBe(1);

    writeFileSync(
      join(root, 'packages/ogi-addon/src/main.ts'),
      'export const version = 2;\n'
    );
    expect(ensureWorkspaceBuilds(packages, { root, runBuild })).toBe(true);
    expect(buildCount).toBe(2);
  });

  test('invalidates fingerprints when dependency metadata changes', () => {
    const root = createWorkspaceFixture();
    const packages: WorkspacePackageName[] = ['ogi-addon'];
    let buildCount = 0;
    const runBuild = (packageNames: readonly WorkspacePackageName[]) => {
      buildCount += 1;
      createOutputs(root, packageNames);
    };

    ensureWorkspaceBuilds(packages, { root, runBuild });
    const initialFingerprint = computeWorkspaceBuildFingerprint(root);
    writeFileSync(join(root, 'bun.lock'), 'lockfile-v2\n');
    expect(computeWorkspaceBuildFingerprint(root)).not.toBe(initialFingerprint);
    expect(ensureWorkspaceBuilds(packages, { root, runBuild })).toBe(true);
    expect(buildCount).toBe(2);
  });

  test('forces release builds even when fingerprints are current', () => {
    const root = createWorkspaceFixture();
    const packages: WorkspacePackageName[] = ['ogi-addon'];
    let buildCount = 0;
    const runBuild = (packageNames: readonly WorkspacePackageName[]) => {
      buildCount += 1;
      createOutputs(root, packageNames);
    };

    ensureWorkspaceBuilds(packages, { root, runBuild });
    expect(
      ensureWorkspaceBuilds(packages, { root, force: true, runBuild })
    ).toBe(true);
    expect(buildCount).toBe(2);
  });

  test('threads the remaining timeout into the package build', () => {
    const root = createWorkspaceFixture();
    const packages: WorkspacePackageName[] = ['ogi-addon'];
    let observedTimeout = 0;
    ensureWorkspaceBuilds(packages, {
      root,
      timeoutMs: 2_000,
      runBuild: (packageNames, timeoutMs) => {
        observedTimeout = timeoutMs;
        createOutputs(root, packageNames);
      },
    });
    expect(observedTimeout).toBeGreaterThan(0);
    expect(observedTimeout).toBeLessThanOrEqual(2_000);
  });

  test('bounds the child process and classifies child timeout', () => {
    let spawnTimeout = 0;
    const timedOutSpawn = ((
      _command: string,
      _arguments: readonly string[],
      options: { timeout?: number }
    ) => {
      spawnTimeout = options.timeout ?? 0;
      return {
        status: null,
        error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      };
    }) as unknown as typeof spawnSync;

    expect(() =>
      runWorkspacePackageBuild(
        ['ogi-addon'],
        '/workspace',
        1_234,
        timedOutSpawn
      )
    ).toThrow(WorkspaceBuildTimeoutError);
    expect(spawnTimeout).toBe(1_234);
  });

  test('writes a content fingerprint marker next to generated output', () => {
    const root = createWorkspaceFixture();
    ensureWorkspaceBuilds(['ogi-addon'], {
      root,
      runBuild: (packageNames) => createOutputs(root, packageNames),
    });
    expect(
      readFileSync(
        join(root, 'packages/ogi-addon/build/.ogi-workspace-build-fingerprint'),
        'utf8'
      ).trim()
    ).toBe(computeWorkspaceBuildFingerprint(root));
  });

  test('targeted preparation waits for an active forced full build', async () => {
    const root = createWorkspaceFixture();
    const allPackages = Object.keys(
      WORKSPACE_BUILD_OUTPUTS
    ) as WorkspacePackageName[];
    ensureWorkspaceBuilds(allPackages, {
      root,
      runBuild: (packageNames) => createOutputs(root, packageNames, 'old\n'),
    });

    const runnerPath = join(root, 'concurrency-runner.ts');
    const helperPath = join(
      import.meta.dir,
      '../../scripts/ensure-workspace-builds'
    );
    writeFileSync(
      runnerPath,
      `import { ensureWorkspaceBuilds, WORKSPACE_BUILD_OUTPUTS } from ${JSON.stringify(helperPath)};\n` +
        `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';\n` +
        `import { dirname, join } from 'node:path';\n` +
        `const [root, mode] = process.argv.slice(2);\n` +
        `const allPackages = Object.keys(WORKSPACE_BUILD_OUTPUTS);\n` +
        `const createOutputs = (names, content) => { for (const name of names) for (const output of WORKSPACE_BUILD_OUTPUTS[name]) { const path = join(root, output); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); } };\n` +
        `if (mode === 'force') { const built = ensureWorkspaceBuilds(allPackages, { root, force: true, timeoutMs: 5000, runBuild: (names) => { writeFileSync(join(root, 'force-started'), '1'); const sleep = new Int32Array(new SharedArrayBuffer(4)); const deadline = Date.now() + 4000; while (!existsSync(join(root, 'target-started'))) { if (Date.now() >= deadline) throw new Error('target did not start'); Atomics.wait(sleep, 0, 0, 10); } Atomics.wait(sleep, 0, 0, 100); createOutputs(names, 'new\\n'); } }); writeFileSync(join(root, 'force-result'), String(built)); }\n` +
        `else { writeFileSync(join(root, 'target-started'), '1'); const built = ensureWorkspaceBuilds(['ogi-addon'], { root, timeoutMs: 5000, runBuild: () => writeFileSync(join(root, 'target-built'), '1') }); const observed = readFileSync(join(root, 'packages/ogi-addon/build/main.mjs'), 'utf8'); writeFileSync(join(root, 'target-result'), JSON.stringify({ built, observed })); }\n`
    );

    const forced = spawn(process.execPath, [runnerPath, root, 'force']);
    await waitForFile(join(root, 'force-started'));
    const targeted = spawn(process.execPath, [runnerPath, root, 'targeted']);
    await Promise.all([waitForProcess(forced), waitForProcess(targeted)]);

    expect(readFileSync(join(root, 'force-result'), 'utf8')).toBe('true');
    expect(
      JSON.parse(readFileSync(join(root, 'target-result'), 'utf8'))
    ).toEqual({ built: false, observed: 'new\n' });
    expect(existsSync(join(root, 'target-built'))).toBe(false);
  });

  test('gives missing owner metadata a bounded publication grace', () => {
    const root = createWorkspaceFixture();
    const lockDirectory = join(
      root,
      'node_modules/.cache/ogi-workspace-build.lock'
    );
    mkdirSync(lockDirectory, { recursive: true });

    expect(lockOwnerIsAlive(lockDirectory, Date.now(), 5_000)).toBe(true);
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockDirectory, old, old);
    expect(lockOwnerIsAlive(lockDirectory, Date.now(), 5_000)).toBe(false);
  });

  test('recovers old corrupt or partial owner metadata after grace', () => {
    const root = createWorkspaceFixture();
    const lockDirectory = join(
      root,
      'node_modules/.cache/ogi-workspace-build.lock'
    );
    mkdirSync(lockDirectory, { recursive: true });
    const old = new Date(Date.now() - 10_000);

    const ownerPath = join(lockDirectory, 'owner.json');
    writeFileSync(ownerPath, '{"pid":');
    utimesSync(ownerPath, old, old);
    expect(lockOwnerIsAlive(lockDirectory, Date.now(), 5_000)).toBe(false);

    writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }));
    utimesSync(ownerPath, old, old);
    expect(lockOwnerIsAlive(lockDirectory, Date.now(), 5_000)).toBe(false);

    writeFileSync(ownerPath, 'null');
    utimesSync(ownerPath, old, old);
    expect(lockOwnerIsAlive(lockDirectory, Date.now(), 5_000)).toBe(false);

    const partialOwnerPath = join(lockDirectory, 'owner.json.partial.tmp');
    writeFileSync(partialOwnerPath, '{"pid":');
    utimesSync(lockDirectory, old, old);
    writeFileSync(ownerPath, '{"pid":');
    utimesSync(ownerPath, new Date(), new Date());
    expect(lockOwnerIsAlive(lockDirectory, Date.now(), 5_000)).toBe(true);
  });

  test('reclaims an old foreign-host owner record', () => {
    const root = createWorkspaceFixture();
    const lockDirectory = join(
      root,
      'node_modules/.cache/ogi-workspace-build.lock'
    );
    mkdirSync(lockDirectory, { recursive: true });
    const ownerPath = join(lockDirectory, 'owner.json');
    writeFileSync(
      ownerPath,
      JSON.stringify({ hostname: `${hostname()}-foreign`, pid: 1 })
    );
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(ownerPath, old, old);

    expect(lockOwnerIsAlive(lockDirectory)).toBe(false);
    expect(
      ensureWorkspaceBuilds(['ogi-addon'], {
        root,
        timeoutMs: 500,
        runBuild: (packageNames) => createOutputs(root, packageNames),
      })
    ).toBe(true);
    expect(existsSync(lockDirectory)).toBe(false);
  });

  test('preserves a plausibly live recent foreign-host owner', () => {
    const root = createWorkspaceFixture();
    const lockDirectory = join(
      root,
      'node_modules/.cache/ogi-workspace-build.lock'
    );
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({ hostname: `${hostname()}-foreign`, pid: 1 })
    );

    expect(lockOwnerIsAlive(lockDirectory)).toBe(true);
  });

  test('honors the caller deadline while a recent foreign owner is live', () => {
    const root = createWorkspaceFixture();
    const lockDirectory = join(
      root,
      'node_modules/.cache/ogi-workspace-build.lock'
    );
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({ hostname: `${hostname()}-foreign`, pid: 1 })
    );
    let built = false;
    const startedAt = Date.now();

    expect(() =>
      ensureWorkspaceBuilds(['ogi-addon'], {
        root,
        timeoutMs: 25,
        runBuild: () => {
          built = true;
        },
      })
    ).toThrow(WorkspaceBuildTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(built).toBe(false);
    expect(existsSync(lockDirectory)).toBe(true);
  });

  test('keeps a valid live owner and publishes owner metadata atomically', () => {
    const root = createWorkspaceFixture();
    const lockDirectory = join(
      root,
      'node_modules/.cache/ogi-workspace-build.lock'
    );
    let observedOwner: unknown;
    let temporaryOwners: string[] = [];

    ensureWorkspaceBuilds(['ogi-addon'], {
      root,
      runBuild: (packageNames) => {
        observedOwner = JSON.parse(
          readFileSync(join(lockDirectory, 'owner.json'), 'utf8')
        );
        temporaryOwners = readdirSync(lockDirectory).filter((name) =>
          name.endsWith('.tmp')
        );
        createOutputs(root, packageNames);
      },
    });

    expect(observedOwner).toEqual({ hostname: hostname(), pid: process.pid });
    expect(temporaryOwners).toEqual([]);

    mkdirSync(lockDirectory, { recursive: true });
    const ownerPath = join(lockDirectory, 'owner.json');
    writeFileSync(
      ownerPath,
      JSON.stringify({ hostname: hostname(), pid: process.pid })
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(ownerPath, old, old);
    expect(lockOwnerIsAlive(lockDirectory, Date.now(), 5_000)).toBe(true);
  });
});
