import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import {
  findTrackedProcessSurvivors,
  getPosixPidTreeTerminationPlan,
  getProcessTreeStrategy,
  getWindowsTaskkillArgs,
  parsePosixProcessTable,
  parseProcStatStartTime,
  parseProcStatState,
  parseWindowsJobResult,
  readProcProcessIdentity,
  spawnTrackedProcess,
  terminatePidTree,
  terminateProcessTree,
  trackProcessTree,
} from '../src/process-tree';

test('selects deterministic platform process-tree containment', () => {
  expect(getProcessTreeStrategy('win32')).toBe('windows-job-object');
  expect(getProcessTreeStrategy('linux')).toBe('posix-process-group');
});

test('targets the Windows Job Object wrapper and its tree', () => {
  expect(getWindowsTaskkillArgs([100, 101])).toEqual([
    '/PID',
    '100',
    '/PID',
    '101',
    '/T',
    '/F',
  ]);
});

test('parses legacy and post-close Windows Job Object evidence', () => {
  expect(
    parseWindowsJobResult({
      version: 1,
      rootPid: 100,
      survivingPids: [201, 202, 201],
    })
  ).toEqual({ version: 1, rootPid: 100, survivingPids: [201, 202] });
  expect(
    parseWindowsJobResult({
      version: 2,
      rootPid: 100,
      activePidsBeforeClose: [100, 201],
      survivingPids: [201],
      timedOut: false,
      killOnClose: true,
    })
  ).toEqual({
    version: 2,
    rootPid: 100,
    activePidsBeforeClose: [100, 201],
    survivingPids: [201],
    timedOut: false,
    killOnClose: true,
    verifiedAfterClose: false,
  });
  expect(
    parseWindowsJobResult({
      version: 3,
      rootPid: 100,
      activePidsBeforeClose: [100, 201],
      terminatedPids: [100, 201],
      survivingPids: [],
      timedOut: false,
      errors: [],
      killOnClose: true,
    })
  ).toEqual({
    version: 3,
    rootPid: 100,
    activePidsBeforeClose: [100, 201],
    terminatedPids: [100, 201],
    survivingPids: [],
    timedOut: false,
    errors: [],
    killOnClose: true,
    verifiedAfterClose: true,
  });
  expect(() =>
    parseWindowsJobResult({ version: 1, rootPid: 100, survivingPids: [0] })
  ).toThrow('invalid');
  expect(() =>
    parseWindowsJobResult({
      version: 3,
      rootPid: 100,
      activePidsBeforeClose: [100, 201],
      terminatedPids: [100],
      survivingPids: [],
      timedOut: false,
      errors: [],
      killOnClose: true,
    })
  ).toThrow('invalid');
});

test('plans only descendants even when the product shares the harness process group', () => {
  const records = parsePosixProcessTable(`
    100 1 50
    200 100 50
    201 200 50
    300 100 50
  `);

  expect(getPosixPidTreeTerminationPlan(200, 300, records)).toEqual([201, 200]);
});

test('refuses to target the harness or one of its ancestors', () => {
  const records = parsePosixProcessTable(`
    100 1 100
    200 100 200
    300 200 300
  `);

  expect(() => getPosixPidTreeTerminationPlan(200, 300, records)).toThrow(
    'Refusing to terminate harness PID or ancestor process'
  );
});

test('uses the Linux process start time as PID reuse identity', () => {
  const fields = ['S', ...Array(18).fill('0'), '4242'];
  const stat = `123 (worker process) ${fields.join(' ')}`;
  expect(parseProcStatStartTime(stat)).toBe('4242');
  expect(parseProcStatState(stat)).toBe('S');
  expect(parseProcStatState(stat.replace(') S ', ') Z '))).toBe('Z');
  expect(readProcProcessIdentity(123, () => stat)).toEqual({
    startTime: '4242',
    state: 'S',
  });
});

test('treats a process disappearing during proc identity inspection as gone', () => {
  for (const code of ['ENOENT', 'ESRCH']) {
    expect(
      readProcProcessIdentity(123, () => {
        throw Object.assign(new Error(`${code}: no such process, read`), {
          code,
        });
      })
    ).toBeUndefined();
  }

  expect(() =>
    readProcProcessIdentity(123, () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    })
  ).toThrow('permission denied');
});

test.skipIf(process.platform === 'win32')(
  'bounded teardown removes a complete POSIX process tree',
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: 'ignore' }
    );
    expect(child.pid).toBeNumber();

    await Effect.runPromise(terminateProcessTree(child));
    expect(() => process.kill(child.pid!, 0)).toThrow();
  }
);

test.skipIf(process.platform === 'win32')(
  'terminates a nested product process tree by root PID without requiring its ChildProcess handle',
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)",
      ],
      { stdio: 'ignore' }
    );
    expect(child.pid).toBeNumber();

    await terminatePidTree(child.pid!);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  }
);

test.skipIf(process.platform === 'win32')(
  'fails explicitly when Linux launch containment cannot be established',
  async () => {
    await expect(
      spawnTrackedProcess(process.execPath, ['-e', 'process.exit(0)'], {
        env: { ...process.env, PATH: '/nonexistent' },
        stdio: 'ignore',
      })
    ).rejects.toThrow('Linux process supervisor did not start');
  }
);

test.skipIf(process.platform === 'win32')(
  'containment evidence corruption reports infrastructure failure after cleanup',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-corrupt-containment-'));
    const orphanPidPath = join(directory, 'orphan.pid');
    const { child, tracker } = await spawnTrackedProcess(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); writeFileSync(${JSON.stringify(orphanPidPath)}, String(child.pid)); child.unref(); setTimeout(() => process.exit(0), 300);`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    try {
      const deadline = Date.now() + 2_000;
      while (!existsSync(orphanPidPath) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      const orphanPid = Number(readFileSync(orphanPidPath, 'utf8'));
      expect(orphanPid).toBeGreaterThan(0);
      expect(tracker?.containmentEvidencePath).toBeTruthy();
      writeFileSync(tracker!.containmentEvidencePath!, '{corrupted');
      await Bun.sleep(100);
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => resolve());
      });
      await expect(findTrackedProcessSurvivors(tracker)).rejects.toThrow();
      await expect(
        Effect.runPromise(terminateProcessTree(child, tracker))
      ).rejects.toThrow('Process tree cleanup reported errors');
      expect([undefined, 'Z']).toContain(
        readProcProcessIdentity(orphanPid)?.state
      );
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000
);

test.skipIf(process.platform === 'win32')(
  'subreaper containment repeatedly captures an immediate detached child after its root exits',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-fast-orphan-tree-'));
    try {
      for (let iteration = 0; iteration < 20; iteration++) {
        const orphanPidPath = join(directory, `orphan-${iteration}.pid`);
        const { child, tracker } = await spawnTrackedProcess(
          process.execPath,
          [
            '-e',
            `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); writeFileSync(${JSON.stringify(orphanPidPath)}, String(child.pid)); child.unref();`,
          ],
          { detached: true, stdio: 'ignore' }
        );
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => resolve());
        });
        const orphanPid = Number(readFileSync(orphanPidPath, 'utf8'));
        expect(orphanPid).toBeGreaterThan(0);
        expect(await findTrackedProcessSurvivors(tracker)).toContain(orphanPid);
        await Effect.runPromise(terminateProcessTree(child, tracker));
        expect([undefined, 'Z']).toContain(
          readProcProcessIdentity(orphanPid)?.state
        );
        expect(() => process.kill(process.pid, 0)).not.toThrow();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000
);

test.skipIf(process.platform === 'win32')(
  'tracked cleanup removes an orphan after its launched root exits',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-orphan-tree-'));
    const orphanPidPath = join(directory, 'orphan.pid');
    const root = spawn(
      '/bin/bash',
      [
        '-c',
        `sleep 60 </dev/null >/dev/null 2>&1 & printf '%s' "$!" > ${JSON.stringify(orphanPidPath)}; sleep 0.2; exit 0`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    const tracker = await trackProcessTree(root);
    await new Promise<void>((resolve, reject) => {
      if (root.exitCode !== null || root.signalCode !== null) {
        resolve();
        return;
      }
      root.once('error', reject);
      root.once('exit', () => resolve());
    });
    const orphanPid = Number(readFileSync(orphanPidPath, 'utf8'));
    expect(orphanPid).toBeGreaterThan(0);
    expect(() => process.kill(orphanPid, 0)).not.toThrow();
    expect(tracker?.dedicatedProcessGroup).toBe(true);
    expect(tracker?.tracked.has(process.pid)).toBe(false);
    expect(await findTrackedProcessSurvivors(tracker, [root.pid!])).toContain(
      orphanPid
    );

    try {
      await Effect.runPromise(terminateProcessTree(root, tracker));
      expect(() => process.kill(orphanPid, 0)).toThrow();
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      if (orphanPid > 0) {
        try {
          process.kill(orphanPid, 'SIGKILL');
        } catch {}
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000
);
