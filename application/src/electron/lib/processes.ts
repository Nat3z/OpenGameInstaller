import { execFile, type ChildProcess } from 'child_process';

type ProcessEntry = {
  pid: number;
  ppid: number;
};

const FORCE_KILL_TIMEOUT_MS = 1500;

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}

async function getUnixProcessTable(): Promise<ProcessEntry[]> {
  const stdout = await execFileAsync('ps', ['-eo', 'pid=,ppid=']);

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .map(([pid, ppid]) => ({
      pid: Number.parseInt(pid, 10),
      ppid: Number.parseInt(ppid, 10),
    }))
    .filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.ppid));
}

async function getWindowsProcessTable(): Promise<ProcessEntry[]> {
  const stdout = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
  ]);

  const raw = stdout.trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw) as
    | { ProcessId?: number; ParentProcessId?: number }
    | Array<{ ProcessId?: number; ParentProcessId?: number }>;

  const rows = Array.isArray(parsed) ? parsed : [parsed];

  return rows
    .map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
    }))
    .filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.ppid));
}

async function getProcessTable(): Promise<ProcessEntry[]> {
  if (process.platform === 'win32') {
    return getWindowsProcessTable();
  }
  return getUnixProcessTable();
}

function getDescendantPids(rootPid: number, table: ProcessEntry[]): number[] {
  const childrenByParent = new Map<number, number[]>();

  for (const entry of table) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.ppid, children);
  }

  const descendants: number[] = [];
  const walk = (pid: number) => {
    const children = childrenByParent.get(pid) ?? [];
    for (const childPid of children) {
      walk(childPid);
      descendants.push(childPid);
    }
  };

  walk(rootPid);
  return descendants;
}

function getProcessPid(target: ChildProcess | number | null | undefined) {
  if (typeof target === 'number') {
    return target;
  }

  return target?.pid ?? null;
}

function killUnixPids(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    if (!pid || pid === process.pid) {
      continue;
    }

    try {
      process.kill(pid, signal);
    } catch (error: any) {
      if (error?.code !== 'ESRCH') {
        console.error(
          `[processes] Failed to send ${signal} to PID ${pid}:`,
          error
        );
      }
    }
  }
}

async function killWindowsPid(
  pid: number,
  options?: {
    includeTree?: boolean;
  }
) {
  const args = ['/PID', String(pid), '/F'];
  if (options?.includeTree !== false) {
    args.push('/T');
  }

  try {
    await execFileAsync('taskkill', args);
  } catch (error: any) {
    const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.toLowerCase();
    if (
      !output.includes('not found') &&
      !output.includes('no running instance') &&
      !output.includes('not running')
    ) {
      console.error(`[processes] Failed to taskkill PID ${pid}:`, error);
    }
  }
}

export async function terminateProcessTree(
  target: ChildProcess | number | null | undefined,
  label = 'process'
): Promise<void> {
  const pid = getProcessPid(target);
  if (!pid || pid === process.pid) {
    return;
  }

  if (!isProcessAlive(pid)) {
    return;
  }

  console.log(`[processes] Terminating ${label} (PID ${pid})`);

  if (process.platform === 'win32') {
    await killWindowsPid(pid);
    return;
  }

  let trackedPids = [pid];
  try {
    const table = await getProcessTable();
    trackedPids = [...getDescendantPids(pid, table), pid];
  } catch (error) {
    console.error(
      `[processes] Failed to inspect descendants for ${label} (PID ${pid}), falling back to direct kill:`,
      error
    );
  }

  killUnixPids(trackedPids, 'SIGTERM');
  await wait(FORCE_KILL_TIMEOUT_MS);

  const remaining = trackedPids.filter((trackedPid) => isProcessAlive(trackedPid));
  if (remaining.length > 0) {
    console.warn(
      `[processes] Force killing ${label}; still alive after SIGTERM: ${remaining.join(', ')}`
    );
    killUnixPids(remaining, 'SIGKILL');
  }
}

export async function terminateCurrentProcessChildren(): Promise<void> {
  let table: ProcessEntry[] = [];
  try {
    table = await getProcessTable();
  } catch (error) {
    console.error('[processes] Failed to inspect child processes:', error);
    return;
  }

  const descendantPids = getDescendantPids(process.pid, table).filter(
    (pid) => pid !== process.pid
  );

  if (descendantPids.length === 0) {
    return;
  }

  if (process.platform === 'win32') {
    for (const pid of descendantPids) {
      await killWindowsPid(pid, { includeTree: false });
    }
    return;
  }

  killUnixPids(descendantPids, 'SIGTERM');
  await wait(FORCE_KILL_TIMEOUT_MS);

  const remaining = descendantPids.filter((pid) => isProcessAlive(pid));
  if (remaining.length > 0) {
    console.warn(
      `[processes] Force killing child processes after SIGTERM: ${remaining.join(', ')}`
    );
    killUnixPids(remaining, 'SIGKILL');
  }
}
