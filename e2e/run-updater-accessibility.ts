import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Cause, Data, Effect, Exit } from 'effect';
import type { UpdaterAccessibilityState } from './updater-accessibility-states';

class UpdaterAccessibilityProcessError extends Data.TaggedError(
  'UpdaterAccessibilityProcessError'
)<{
  readonly command: string;
  readonly status: number | null;
  readonly signal: string | null;
  readonly cause?: unknown;
}> {}

class UpdaterAccessibilityTimeoutError extends Data.TaggedError(
  'UpdaterAccessibilityTimeoutError'
)<{
  readonly state: string;
  readonly timeout: string;
}> {}

class AxeSourceError extends Data.TaggedError('AxeSourceError')<{
  readonly source: string;
  readonly cause: unknown;
}> {}

class ProcessTreeCleanupError extends Data.TaggedError(
  'ProcessTreeCleanupError'
)<{
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const axeSource = resolve(
  currentDirectory,
  '../node_modules/axe-core/axe.min.js'
);

const verifyAxeSource = Effect.try({
  try: () => accessSync(axeSource, constants.R_OK),
  catch: (cause) => new AxeSourceError({ source: axeSource, cause }),
});

function waitForExit(child: ChildProcess, timeoutMs: number) {
  return new Promise<{
    readonly exited: boolean;
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({
        exited: true,
        status: child.exitCode,
        signal: child.signalCode,
      });
      return;
    }
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      resolveExit({ exited: true, status, signal });
    };
    const timeout = setTimeout(() => {
      child.off('exit', finish);
      resolveExit({ exited: false, status: null, signal: null });
    }, timeoutMs);
    child.once('exit', finish);
  });
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function posixProcessGroupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntilGone(checkAlive: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (checkAlive() && Date.now() < deadline) {
    await delay(50);
  }
  return !checkAlive();
}

function signalPosixTree(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw cause;
    }
    if (processExists(pid)) {
      process.kill(pid, signal);
    }
  }
}

async function getWindowsProcessTree(rootPid: number) {
  const query = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  query.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  query.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const result = await waitForExit(query, 10_000);
  if (!result.exited) {
    query.kill('SIGKILL');
    throw new ProcessTreeCleanupError({
      pid: rootPid,
      platform: 'win32',
      detail: 'Windows process-tree query did not complete within 10 seconds',
    });
  }
  if (result.status !== 0) {
    throw new ProcessTreeCleanupError({
      pid: rootPid,
      platform: 'win32',
      detail: `Windows process-tree query failed with status ${result.status}: ${stderr.trim()}`,
    });
  }

  const parsed = JSON.parse(stdout) as
    | { ProcessId: number; ParentProcessId: number }
    | Array<{ ProcessId: number; ParentProcessId: number }>;
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const tree = new Set([rootPid]);
  let added = true;
  while (added) {
    added = false;
    for (const processInfo of processes) {
      if (
        tree.has(processInfo.ParentProcessId) &&
        !tree.has(processInfo.ProcessId)
      ) {
        tree.add(processInfo.ProcessId);
        added = true;
      }
    }
  }
  return tree;
}

async function terminateProcessTree(child: ChildProcess) {
  if (child.pid === undefined) return;
  const pid = child.pid;

  if (process.platform === 'win32') {
    const tree = await getWindowsProcessTree(pid);
    const survivingPids = () => [...tree].filter(processExists);
    const initialSurvivors = survivingPids();
    if (initialSurvivors.length === 0) return;
    const killer = spawn(
      'taskkill',
      [
        ...initialSurvivors.flatMap((processId) => ['/PID', String(processId)]),
        '/T',
        '/F',
      ],
      { stdio: 'ignore' }
    );
    const result = await waitForExit(killer, 10_000);
    if (!result.exited) {
      killer.kill('SIGKILL');
      throw new ProcessTreeCleanupError({
        pid,
        platform: process.platform,
        detail: 'taskkill did not complete within 10 seconds',
      });
    }
    if (result.status !== 0 && survivingPids().length > 0) {
      throw new ProcessTreeCleanupError({
        pid,
        platform: process.platform,
        detail: `taskkill exited with status ${result.status}; surviving PIDs: ${survivingPids().join(', ')}`,
      });
    }
    if (!(await waitUntilGone(() => survivingPids().length > 0, 2_000))) {
      throw new ProcessTreeCleanupError({
        pid,
        platform: process.platform,
        detail: `process tree still exists after taskkill completed; surviving PIDs: ${survivingPids().join(', ')}`,
      });
    }
    return;
  }

  const treeExists = () => posixProcessGroupExists(pid) || processExists(pid);
  if (!treeExists()) return;
  try {
    signalPosixTree(pid, 'SIGTERM');
  } catch (cause) {
    throw new ProcessTreeCleanupError({
      pid,
      platform: process.platform,
      detail: 'failed to send SIGTERM to the process group',
      cause,
    });
  }
  if (await waitUntilGone(treeExists, 2_000)) return;
  try {
    signalPosixTree(pid, 'SIGKILL');
  } catch (cause) {
    throw new ProcessTreeCleanupError({
      pid,
      platform: process.platform,
      detail: 'failed to send SIGKILL to the process group',
      cause,
    });
  }
  if (!(await waitUntilGone(treeExists, 2_000))) {
    throw new ProcessTreeCleanupError({
      pid,
      platform: process.platform,
      detail: 'process group still exists after SIGKILL',
    });
  }
}

function runState(state: UpdaterAccessibilityState) {
  return Effect.scoped(
    Effect.gen(function* () {
      const sandboxDirectory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), `ogi-updater-${state}-`))),
        (directory) =>
          Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
      );
      const command = process.platform === 'linux' ? 'xvfb-run' : 'bunx';
      const args =
        process.platform === 'linux'
          ? ['-a', 'bunx', 'wdio', 'run', './updater-wdio.conf.ts']
          : ['wdio', 'run', './updater-wdio.conf.ts'];
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(command, args, {
              cwd: currentDirectory,
              detached: process.platform !== 'win32',
              env: {
                ...process.env,
                OGI_AXE_SOURCE: axeSource,
                OGI_SCENARIO_SANDBOX: sandboxDirectory,
                OGI_UPDATER_ACCESSIBILITY_STATE: state,
              },
              stdio: 'inherit',
            }),
          catch: (cause) =>
            new UpdaterAccessibilityProcessError({
              command: [command, ...args].join(' '),
              status: null,
              signal: null,
              cause,
            }),
        }),
        (processHandle) =>
          Effect.tryPromise({
            try: () => terminateProcessTree(processHandle),
            catch: (cause) =>
              cause instanceof ProcessTreeCleanupError
                ? cause
                : new ProcessTreeCleanupError({
                    pid: processHandle.pid ?? -1,
                    platform: process.platform,
                    detail: 'unexpected process-tree cleanup failure',
                    cause,
                  }),
          }).pipe(Effect.orDie)
      );

      yield* Effect.async<void, UpdaterAccessibilityProcessError>((resume) => {
        const onError = (cause: Error) =>
          resume(
            Effect.fail(
              new UpdaterAccessibilityProcessError({
                command: [command, ...args].join(' '),
                status: null,
                signal: null,
                cause,
              })
            )
          );
        const onExit = (status: number | null, signal: NodeJS.Signals | null) =>
          resume(
            status === 0
              ? Effect.void
              : Effect.fail(
                  new UpdaterAccessibilityProcessError({
                    command: [command, ...args].join(' '),
                    status,
                    signal,
                  })
                )
          );
        if (child.exitCode !== null || child.signalCode !== null) {
          onExit(child.exitCode, child.signalCode);
          return;
        }
        child.once('error', onError);
        child.once('exit', onExit);
        return Effect.sync(() => {
          child.off('error', onError);
          child.off('exit', onExit);
        });
      }).pipe(
        Effect.timeoutFail({
          duration: '3 minutes',
          onTimeout: () =>
            new UpdaterAccessibilityTimeoutError({
              state,
              timeout: '3 minutes',
            }),
        })
      );
    })
  );
}

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* verifyAxeSource;
    // All deterministic updater states are exercised in one Electron session.
    // Starting four ChromeDriver sessions made their identical shutdown cost
    // dominate the PR budget without adding state isolation value.
    yield* runState('selection');
  })
);

const exit = await Effect.runPromiseExit(program);
Exit.match(exit, {
  onFailure: (cause) => {
    console.error(Cause.pretty(cause));
    process.exitCode = 1;
  },
  onSuccess: () => {
    process.exitCode = 0;
  },
});
