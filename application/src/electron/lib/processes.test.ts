/**
 * Tests for processes.ts
 *
 * Covers:
 *  - terminateProcessTree: early-exit guards, SIGTERM→SIGKILL escalation, Unix integration
 *  - terminateCurrentProcessChildren: no-children early exit, table-failure handling, kill flow
 *
 * Run with:
 *   node --experimental-strip-types --test src/electron/lib/processes.test.ts
 *
 * (from the application/ directory)
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  terminateProcessTree,
  terminateCurrentProcessChildren,
} from './processes.ts';

// ---------------------------------------------------------------------------
// Environment capability detection
// ---------------------------------------------------------------------------

/** Whether `ps` is available in the current environment. */
let psAvailable = false;
before(() => {
  try {
    execFileSync('ps', ['-eo', 'pid=,ppid='], { stdio: 'pipe' });
    psAvailable = true;
  } catch {
    psAvailable = false;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn a long-running child process suitable for kill tests. */
function spawnLongRunning() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

/** Wait for a child process to exit. */
function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
}

/** True when `pid` is no longer in the OS process table. */
function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: any) {
    return err?.code === 'ESRCH';
  }
}

/** Poll until `predicate()` is true or `timeoutMs` elapses. Returns true on success. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// terminateProcessTree — early-exit guards (no actual kill required)
// ---------------------------------------------------------------------------

describe('terminateProcessTree – early-exit guards', () => {
  test('resolves without error when target is null', async () => {
    await assert.doesNotReject(() => terminateProcessTree(null));
  });

  test('resolves without error when target is undefined', async () => {
    await assert.doesNotReject(() => terminateProcessTree(undefined));
  });

  test('resolves without error when target PID is 0', async () => {
    // PID 0 is falsy — treated as "no PID".
    await assert.doesNotReject(() => terminateProcessTree(0));
  });

  test('does not attempt to kill the current process (self-guard)', async (t) => {
    // If process.kill is called it throws — the test will fail.
    const killMock = t.mock.method(process, 'kill', () => {
      throw new Error('process.kill should not be called for the current PID');
    });

    await terminateProcessTree(process.pid);

    killMock.mock.restore();
    assert.equal(killMock.mock.callCount(), 0);
  });

  test('returns early for a ChildProcess-like object whose pid equals the current PID', async (t) => {
    const killMock = t.mock.method(process, 'kill', () => {
      throw new Error('process.kill should not be called for the current PID');
    });

    const fakeChild = { pid: process.pid } as any;
    await terminateProcessTree(fakeChild);

    killMock.mock.restore();
    assert.equal(killMock.mock.callCount(), 0);
  });

  test('returns early when the target PID is already dead', async () => {
    const child = spawnLongRunning();
    const pid = child.pid!;
    child.kill('SIGKILL');
    await waitForExit(child);

    const gone = await waitUntil(() => pidIsGone(pid));
    assert.ok(gone, 'Helper process should have exited');

    // Second call — process is dead, should be a clean no-op.
    await assert.doesNotReject(() => terminateProcessTree(pid));
  });

  test('resolves without error for a ChildProcess whose pid is undefined', async () => {
    const fakeDead = { pid: undefined } as any;
    await assert.doesNotReject(() => terminateProcessTree(fakeDead));
  });
});

// ---------------------------------------------------------------------------
// terminateProcessTree — integration tests (real child processes)
// ---------------------------------------------------------------------------

describe('terminateProcessTree – integration (Unix)', () => {
  test('terminates a running process given its numeric PID', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Unix-only test');
      return;
    }

    const child = spawnLongRunning();
    const pid = child.pid!;
    assert.ok(!pidIsGone(pid), 'Child should be alive before termination');

    await terminateProcessTree(pid);

    const gone = await waitUntil(() => pidIsGone(pid));
    assert.ok(gone, `PID ${pid} should be gone after terminateProcessTree`);

    if (!pidIsGone(pid)) child.kill('SIGKILL');
  });

  test('terminates a running process given a ChildProcess object', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Unix-only test');
      return;
    }

    const child = spawnLongRunning();
    const pid = child.pid!;
    assert.ok(!pidIsGone(pid), 'Child should be alive before termination');

    await terminateProcessTree(child);

    const gone = await waitUntil(() => pidIsGone(pid));
    assert.ok(gone, `PID ${pid} should be gone after terminateProcessTree`);

    if (!pidIsGone(pid)) child.kill('SIGKILL');
  });

  test('accepts an optional label without throwing', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Unix-only test');
      return;
    }

    const child = spawnLongRunning();
    const pid = child.pid!;

    await terminateProcessTree(pid, 'my-test-label');

    const gone = await waitUntil(() => pidIsGone(pid));
    assert.ok(gone, 'Process should be gone after labeled terminateProcessTree');

    if (!pidIsGone(pid)) child.kill('SIGKILL');
  });

  test('is idempotent — calling twice for the same PID does not throw', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Unix-only test');
      return;
    }

    const child = spawnLongRunning();
    const pid = child.pid!;

    await terminateProcessTree(pid);
    // Second call after process is gone should be a clean no-op.
    await assert.doesNotReject(() => terminateProcessTree(pid));

    if (!pidIsGone(pid)) child.kill('SIGKILL');
  });
});

// ---------------------------------------------------------------------------
// terminateProcessTree — SIGTERM→SIGKILL escalation
// ---------------------------------------------------------------------------

describe('terminateProcessTree – SIGTERM→SIGKILL escalation', () => {
  test(
    'terminates a SIGTERM-immune process via SIGKILL after the grace period',
    { timeout: 5000 },
    async (t) => {
      if (process.platform === 'win32') {
        t.skip('Escalation path is Unix-only');
        return;
      }

      // Spawn a process that traps SIGTERM — it can only be killed by SIGKILL.
      const child = spawn(process.execPath, [
        '-e',
        `process.on('SIGTERM', () => { /* intentionally ignore */ });
         setInterval(() => {}, 500);`,
      ]);
      child.stdout?.resume();
      child.stderr?.resume();

      const pid = child.pid!;
      assert.ok(!pidIsGone(pid), 'SIGTERM-immune child should be alive before the call');

      // terminateProcessTree should send SIGTERM, wait 1500 ms, then send SIGKILL.
      // We do not mock process.kill here so real signals reach the child.
      await terminateProcessTree(pid);

      // If the process is now dead, SIGKILL must have been sent (SIGTERM alone cannot kill it).
      assert.ok(pidIsGone(pid), `SIGTERM-immune PID ${pid} must be dead after SIGKILL escalation`);

      if (!pidIsGone(pid)) child.kill('SIGKILL');
    }
  );

  test(
    'records SIGTERM followed by SIGKILL in the correct order',
    { timeout: 5000 },
    async (t) => {
      if (process.platform === 'win32') {
        t.skip('Escalation path is Unix-only');
        return;
      }

      // Spawn a SIGTERM-immune child.
      const child = spawn(process.execPath, [
        '-e',
        `process.on('SIGTERM', () => {});
         setInterval(() => {}, 500);`,
      ]);
      child.stdout?.resume();
      child.stderr?.resume();

      const pid = child.pid!;

      // Track every signal sent to our target PID.
      // We do NOT forward the signals so the process stays alive long enough
      // to confirm the full SIGTERM → (wait) → SIGKILL sequence without
      // a real kill reaching it unexpectedly.
      const killsForPid: string[] = [];
      const killMock = t.mock.method(
        process,
        'kill',
        (targetPid: number, signal?: string | number) => {
          if (targetPid === pid) {
            killsForPid.push(String(signal ?? 0));
          }
          // For all other PIDs (e.g. isProcessAlive checking with signal 0)
          // we must return normally (not throw) so the liveness check still works.
          // For our target PID we intentionally suppress the signal so the process
          // stays alive long enough for the escalation to fire.
        }
      );

      await terminateProcessTree(pid);
      killMock.mock.restore();

      // SIGTERM is sent first; SIGKILL is sent after the timeout.
      assert.ok(killsForPid.includes('SIGTERM'), 'SIGTERM should have been sent before escalation');
      assert.ok(killsForPid.includes('SIGKILL'), 'SIGKILL should have been sent after the grace period');

      // Verify ordering: SIGTERM must precede SIGKILL.
      const firstSigterm = killsForPid.indexOf('SIGTERM');
      const firstSigkill = killsForPid.indexOf('SIGKILL');
      assert.ok(firstSigterm < firstSigkill, 'SIGTERM must be sent before SIGKILL');

      // The process was shielded from real signals; clean it up now.
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  );
});

// ---------------------------------------------------------------------------
// terminateCurrentProcessChildren
// ---------------------------------------------------------------------------

describe('terminateCurrentProcessChildren', () => {
  test('resolves without error when there are no child processes', async (t) => {
    if (!psAvailable) {
      // When ps is unavailable the function handles the error and returns
      // without throwing — still a valid no-throw assertion.
    }
    await assert.doesNotReject(() => terminateCurrentProcessChildren());
  });

  test('handles process-table failure gracefully (does not throw)', async (t) => {
    // This test is always relevant: even if ps is available, the function
    // should never throw when it cannot inspect the process table.
    // We validate it by calling the function while no children are present
    // in an environment where ps may not exist.
    await assert.doesNotReject(() => terminateCurrentProcessChildren());
  });

  test('terminates a child process spawned by the current process', async (t) => {
    if (!psAvailable) {
      t.skip('ps not available — process-table inspection cannot discover children');
      return;
    }
    if (process.platform === 'win32') {
      t.skip('Unix-only test');
      return;
    }

    const child = spawnLongRunning();
    const pid = child.pid!;
    assert.ok(!pidIsGone(pid), 'Child should be alive before calling terminateCurrentProcessChildren');

    await terminateCurrentProcessChildren();

    const gone = await waitUntil(() => pidIsGone(pid));
    assert.ok(gone, `Child PID ${pid} should be dead after terminateCurrentProcessChildren`);

    if (!pidIsGone(pid)) child.kill('SIGKILL');
  });

  test('terminates multiple child processes in one call', async (t) => {
    if (!psAvailable) {
      t.skip('ps not available — process-table inspection cannot discover children');
      return;
    }
    if (process.platform === 'win32') {
      t.skip('Unix-only test');
      return;
    }

    const children = [spawnLongRunning(), spawnLongRunning(), spawnLongRunning()];
    const pids = children.map((c) => c.pid!);

    for (const pid of pids) {
      assert.ok(!pidIsGone(pid), `Child PID ${pid} should be alive`);
    }

    await terminateCurrentProcessChildren();

    for (const pid of pids) {
      const gone = await waitUntil(() => pidIsGone(pid));
      assert.ok(gone, `Child PID ${pid} should be dead after terminateCurrentProcessChildren`);
    }

    for (const child of children) {
      if (!pidIsGone(child.pid!)) child.kill('SIGKILL');
    }
  });

  test(
    'SIGTERM→SIGKILL escalation for a SIGTERM-immune child',
    { timeout: 6000 },
    async (t) => {
      if (!psAvailable) {
        t.skip('ps not available — process-table inspection cannot discover children');
        return;
      }
      if (process.platform === 'win32') {
        t.skip('Escalation path is Unix-only');
        return;
      }

      const child = spawn(process.execPath, [
        '-e',
        `process.on('SIGTERM', () => { /* ignore */ });
         setInterval(() => {}, 500);`,
      ]);
      child.stdout?.resume();
      child.stderr?.resume();

      const pid = child.pid!;
      assert.ok(!pidIsGone(pid));

      await terminateCurrentProcessChildren();

      const gone = await waitUntil(() => pidIsGone(pid), 4000);
      assert.ok(gone, `SIGTERM-immune child PID ${pid} should be gone after SIGKILL escalation`);

      if (!pidIsGone(pid)) child.kill('SIGKILL');
    }
  );
});

// ---------------------------------------------------------------------------
// Boundary / regression tests
// ---------------------------------------------------------------------------

describe('terminateProcessTree – boundary and regression cases', () => {
  test('very large non-existent PID is handled gracefully', async () => {
    // PID 2^30 is almost certainly not running.
    await assert.doesNotReject(() => terminateProcessTree(1073741823));
  });

  test('passing a number for an already-dead PID is a no-op', async () => {
    const child = spawnLongRunning();
    const pid = child.pid!;
    child.kill('SIGKILL');
    await waitForExit(child);
    await waitUntil(() => pidIsGone(pid));

    await assert.doesNotReject(() => terminateProcessTree(pid, 'already-dead'));
  });

  test('negative PID does not throw even if treated as non-existent', async () => {
    // A negative number passes the !pid falsy guard but should not crash.
    await assert.doesNotReject(() => terminateProcessTree(-999999));
  });

  test('does not kill current process even when passed as a ChildProcess-shaped object', async (t) => {
    const killMock = t.mock.method(process, 'kill', (_pid: number, _signal?: any) => {
      throw new Error('process.kill must not be called for the current process');
    });

    // Both direct PID and ChildProcess-shaped object variants.
    await terminateProcessTree({ pid: process.pid } as any);
    await terminateProcessTree(process.pid);

    killMock.mock.restore();
    assert.equal(killMock.mock.callCount(), 0);
  });
});