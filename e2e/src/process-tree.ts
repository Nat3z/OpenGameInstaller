import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Data, Effect } from 'effect';

export function getProcessTreeStrategy(platform: NodeJS.Platform) {
  return platform === 'win32' ? 'windows-job-object' : 'posix-process-group';
}

export function getWindowsTaskkillArgs(pids: readonly number[]) {
  return [...pids.flatMap((pid) => ['/PID', String(pid)]), '/T', '/F'];
}

export class ProcessTreeCleanupError extends Data.TaggedError(
  'ProcessTreeCleanupError'
)<{
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.detail;
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function groupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntilGone(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (check() && Date.now() < deadline) await delay(50);
  return !check();
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  return new Promise<number | null | undefined>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(undefined);
    }, timeoutMs);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      resolve(code);
    };
    child.once('exit', onExit);
  });
}

async function terminate(child: ChildProcess) {
  if (child.pid === undefined) return;
  const pid = child.pid;
  if (getProcessTreeStrategy(process.platform) === 'windows-job-object') {
    if (!processExists(pid)) return;
    const killer = spawn('taskkill', getWindowsTaskkillArgs([pid]), {
      stdio: 'ignore',
    });
    const status = await waitForExit(killer, 10_000);
    if (status === undefined) {
      killer.kill('SIGKILL');
      throw new Error('taskkill timed out after 10 seconds');
    }
    if (!(await waitUntilGone(() => processExists(pid), 2_000))) {
      throw new Error(`Windows Job Object wrapper survived: ${pid}`);
    }
    return;
  }

  const alive = () => groupExists(pid) || processExists(pid);
  if (!alive()) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
  }
  if (await waitUntilGone(alive, 2_000)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
  }
  await waitForExit(child, 2_000);
  if (!(await waitUntilGone(alive, 2_000))) {
    throw new Error('process group still exists after SIGKILL');
  }
}

export const terminateProcessTree = (child: ChildProcess) =>
  Effect.tryPromise({
    try: () => terminate(child),
    catch: (cause) =>
      cause instanceof ProcessTreeCleanupError
        ? cause
        : new ProcessTreeCleanupError({
            pid: child.pid ?? -1,
            platform: process.platform,
            detail: `Failed to remove process tree: ${(cause as Error).message}`,
            cause,
          }),
  }).pipe(
    Effect.timeoutFail({
      duration: '15 seconds',
      onTimeout: () =>
        new ProcessTreeCleanupError({
          pid: child.pid ?? -1,
          platform: process.platform,
          detail: 'Process tree cleanup exceeded 15 seconds',
        }),
    })
  );
