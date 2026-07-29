import {
  type ChildProcess,
  execFile,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Data, Effect } from 'effect';

const execFileAsync = promisify(execFile);

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

export class ProcessTreeTrackingError extends Data.TaggedError(
  'ProcessTreeTrackingError'
)<{
  readonly operation: 'spawn' | 'track' | 'inspect';
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

export type PosixProcessRecord = {
  pid: number;
  parentPid: number;
  processGroupId: number;
};

export type WindowsJobResult = {
  version: 1;
  rootPid: number;
  survivingPids: number[];
};

function isPidArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((pid) => Number.isInteger(pid) && Number(pid) > 0)
  );
}

export function parseWindowsJobResult(input: unknown): WindowsJobResult {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Windows Job Object result must be an object');
  }
  const result = input as Record<string, unknown>;
  if (
    Number(result.version) !== 1 ||
    !Number.isInteger(result.rootPid) ||
    Number(result.rootPid) < 1 ||
    !isPidArray(result.survivingPids)
  ) {
    throw new Error('Windows Job Object result is invalid');
  }
  return {
    version: 1,
    rootPid: Number(result.rootPid),
    survivingPids: [...new Set(result.survivingPids.map(Number))],
  };
}

export function readWindowsJobSurvivors(resultPath: string) {
  return parseWindowsJobResult(
    JSON.parse(readFileSync(resultPath, 'utf8')) as unknown
  ).survivingPids;
}

export function parsePosixProcessTable(output: string): PosixProcessRecord[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (values) =>
        values.length === 3 && values.every((value) => Number.isInteger(value))
    )
    .map(([pid, parentPid, processGroupId]) => ({
      pid,
      parentPid,
      processGroupId,
    }));
}

export function getPosixPidTreeTerminationPlan(
  rootPid: number,
  currentPid: number,
  records: readonly PosixProcessRecord[]
) {
  const byPid = new Map(records.map((record) => [record.pid, record] as const));
  if (!byPid.has(rootPid)) return [];

  const protectedAncestors = new Set<number>();
  let ancestorPid: number | undefined = currentPid;
  while (ancestorPid && !protectedAncestors.has(ancestorPid)) {
    protectedAncestors.add(ancestorPid);
    ancestorPid = byPid.get(ancestorPid)?.parentPid;
  }
  if (protectedAncestors.has(rootPid)) {
    throw new Error(
      `Refusing to terminate harness PID or ancestor process: ${rootPid}`
    );
  }

  const childrenByParent = new Map<number, number[]>();
  for (const record of records) {
    const children = childrenByParent.get(record.parentPid) ?? [];
    children.push(record.pid);
    childrenByParent.set(record.parentPid, children);
  }
  const targets: number[] = [];
  const visited = new Set<number>();
  const visit = (pid: number) => {
    if (visited.has(pid)) return;
    visited.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
    if (protectedAncestors.has(pid)) {
      throw new Error(`Product tree includes protected harness PID: ${pid}`);
    }
    targets.push(pid);
  };
  visit(rootPid);
  return targets;
}

async function readPosixProcessTable() {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,pgid=']);
  return parsePosixProcessTable(stdout);
}

function parseProcStatFields(stat: string) {
  const endOfCommand = stat.lastIndexOf(') ');
  return endOfCommand < 0
    ? undefined
    : stat
        .slice(endOfCommand + 2)
        .trim()
        .split(/\s+/);
}

export function parseProcStatStartTime(stat: string) {
  const startTime = parseProcStatFields(stat)?.[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
}

export function parseProcStatState(stat: string) {
  const state = parseProcStatFields(stat)?.[0];
  return state && /^[A-Z]$/.test(state) ? state : undefined;
}

type ProcProcessIdentity = {
  startTime: string;
  state: string;
};

type ProcStatReader = (path: string, encoding: 'utf8') => string;

export function readProcProcessIdentity(
  pid: number,
  readStat: ProcStatReader = readFileSync
): ProcProcessIdentity | undefined {
  try {
    const stat = readStat(`/proc/${pid}/stat`, 'utf8');
    const startTime = parseProcStatStartTime(stat);
    const state = parseProcStatState(stat);
    return startTime && state ? { startTime, state } : undefined;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return undefined;
    throw cause;
  }
}

function readProcessStartTime(pid: number) {
  return readProcProcessIdentity(pid)?.startTime;
}

type TrackedProcessIdentity = {
  pid: number;
  startTime: string;
};

export type ProcessTreeTracker = {
  rootPid: number;
  rootStartTime: string;
  rootProcessGroupId: number;
  dedicatedProcessGroup: boolean;
  tracked: Map<number, TrackedProcessIdentity>;
  interval?: NodeJS.Timeout;
  pendingRefresh: Promise<void>;
  refreshError?: unknown;
  containmentEvidencePath?: string;
  containmentEvidenceError?: unknown;
};

const trackedChildren = new WeakMap<ChildProcess, ProcessTreeTracker>();

const LINUX_SUBREAPER_SUPERVISOR = `
import ctypes, json, os, signal, subprocess, sys, time
command, *args = sys.argv[1:]
def write_result(value):
    encoded = ('\\n' + json.dumps(value) + '\\n').encode('utf-8')
    os.lseek(3, 0, os.SEEK_END)
    os.write(3, encoded)
    os.fsync(3)
try:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'prctl(PR_SET_CHILD_SUBREAPER) failed')
except BaseException as error:
    write_result({'version': 1, 'error': str(error), 'survivors': []})
    sys.exit(125)
os.kill(os.getpid(), signal.SIGSTOP)
try:
    target = subprocess.Popen([command, *args])
except BaseException as error:
    write_result({'version': 1, 'error': 'target launch failed: ' + str(error), 'survivors': []})
    sys.exit(127)
status = target.wait()
time.sleep(0.05)
records = {}
for name in os.listdir('/proc'):
    if not name.isdigit():
        continue
    try:
        stat = open('/proc/' + name + '/stat', encoding='utf-8').read()
        fields = stat[stat.rfind(') ') + 2:].split()
        records[int(name)] = (int(fields[1]), fields[19])
    except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError, ValueError):
        pass
children = {}
for pid, (parent, start_time) in records.items():
    children.setdefault(parent, []).append((pid, start_time))
survivors = []
stack = [os.getpid()]
seen = set(stack)
while stack:
    parent = stack.pop()
    for pid, start_time in children.get(parent, []):
        if pid == target.pid or pid in seen:
            continue
        seen.add(pid)
        survivors.append({'pid': pid, 'startTime': start_time})
        stack.append(pid)
write_result({'version': 1, 'survivors': survivors})
if status < 0:
    os.kill(os.getpid(), -status)
sys.exit(status)
`;

function protectedHarnessPids(
  currentPid: number,
  records: readonly PosixProcessRecord[]
) {
  const byPid = new Map(records.map((record) => [record.pid, record] as const));
  const protectedPids = new Set<number>();
  let pid: number | undefined = currentPid;
  while (pid && !protectedPids.has(pid)) {
    protectedPids.add(pid);
    pid = byPid.get(pid)?.parentPid;
  }
  return protectedPids;
}

function ingestContainmentEvidence(tracker: ProcessTreeTracker) {
  const resultPath = tracker.containmentEvidencePath;
  if (!resultPath || !existsSync(resultPath)) return;
  const errors: unknown[] = [];
  const results: Array<{
    version?: unknown;
    error?: unknown;
    survivors?: unknown;
  }> = [];
  for (const line of readFileSync(resultPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)) {
    try {
      results.push(JSON.parse(line) as (typeof results)[number]);
    } catch (cause) {
      errors.push(cause);
    }
  }
  for (const result of results) {
    if (result.version !== 1 || !Array.isArray(result.survivors)) {
      errors.push(new Error('Linux launch containment evidence is invalid'));
      continue;
    }
    if (typeof result.error === 'string') {
      errors.push(
        new Error(`Linux launch containment failed: ${result.error}`)
      );
      continue;
    }
    for (const survivor of result.survivors) {
      if (
        typeof survivor !== 'object' ||
        survivor === null ||
        !Number.isInteger((survivor as { pid?: unknown }).pid) ||
        Number((survivor as { pid: number }).pid) < 1 ||
        typeof (survivor as { startTime?: unknown }).startTime !== 'string'
      ) {
        errors.push(
          new Error('Linux launch containment survivor evidence is invalid')
        );
        continue;
      }
      const identity = survivor as TrackedProcessIdentity;
      const existing = tracker.tracked.get(identity.pid);
      if (existing && existing.startTime !== identity.startTime) continue;
      tracker.tracked.set(identity.pid, identity);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Linux launch containment evidence is invalid'
    );
  }
}

async function refreshProcessTreeTracker(tracker: ProcessTreeTracker) {
  try {
    ingestContainmentEvidence(tracker);
  } catch (cause) {
    tracker.containmentEvidenceError ??= cause;
  }
  const records = await readPosixProcessTable();
  const protectedPids = protectedHarnessPids(process.pid, records);
  const rootRecord = records.find((record) => record.pid === tracker.rootPid);
  const candidates = new Set<number>();
  if (
    rootRecord &&
    readProcessStartTime(tracker.rootPid) === tracker.rootStartTime
  ) {
    for (const pid of getPosixPidTreeTerminationPlan(
      tracker.rootPid,
      process.pid,
      records
    )) {
      candidates.add(pid);
    }
  }
  if (tracker.dedicatedProcessGroup) {
    for (const record of records) {
      if (record.processGroupId === tracker.rootProcessGroupId) {
        candidates.add(record.pid);
      }
    }
  }
  for (const pid of candidates) {
    if (protectedPids.has(pid)) {
      throw new Error(`Refusing to track protected harness PID: ${pid}`);
    }
    const startTime = readProcessStartTime(pid);
    if (!startTime) continue;
    const existing = tracker.tracked.get(pid);
    if (existing && existing.startTime !== startTime) continue;
    tracker.tracked.set(pid, { pid, startTime });
  }
}

async function trackPidTree(rootPid: number) {
  const records = await readPosixProcessTable();
  const rootRecord = records.find((record) => record.pid === rootPid);
  const currentRecord = records.find((record) => record.pid === process.pid);
  const rootStartTime = readProcessStartTime(rootPid);
  if (!rootRecord || !rootStartTime || !currentRecord) {
    throw new Error(`Cannot capture launched process identity: ${rootPid}`);
  }
  const tracker: ProcessTreeTracker = {
    rootPid,
    rootStartTime,
    rootProcessGroupId: rootRecord.processGroupId,
    dedicatedProcessGroup:
      rootRecord.processGroupId !== currentRecord.processGroupId,
    tracked: new Map(),
    pendingRefresh: Promise.resolve(),
  };
  const scheduleRefresh = () => {
    tracker.pendingRefresh = tracker.pendingRefresh
      .then(() => refreshProcessTreeTracker(tracker))
      .catch((cause) => {
        tracker.refreshError = cause;
      });
  };
  scheduleRefresh();
  await tracker.pendingRefresh;
  if (tracker.refreshError) throw tracker.refreshError;
  tracker.interval = setInterval(scheduleRefresh, 25);
  return tracker;
}

async function trackProcessTreePromise(child: ChildProcess) {
  if (!child.pid) throw new Error('Cannot track a process without a PID');
  if (process.platform === 'win32') return undefined;
  const tracker = await trackPidTree(child.pid);
  trackedChildren.set(child, tracker);
  return tracker;
}

function withContainmentEvidenceFd(
  stdio: SpawnOptions['stdio'],
  evidenceFd: number
): SpawnOptions['stdio'] {
  const standard = Array.isArray(stdio)
    ? [...stdio]
    : [stdio ?? 'pipe', stdio ?? 'pipe', stdio ?? 'pipe'];
  standard[3] = evidenceFd;
  return standard as SpawnOptions['stdio'];
}

async function spawnTrackedProcessPromise(
  command: string,
  args: readonly string[],
  options: SpawnOptions
): Promise<{ child: ChildProcess; tracker: ProcessTreeTracker | undefined }> {
  if (process.platform === 'win32') {
    const child = spawn(command, args, options);
    return { child, tracker: await trackProcessTreePromise(child) };
  }

  const containmentEvidencePath = join(
    tmpdir(),
    `ogi-process-containment-${randomUUID()}.json`
  );
  writeFileSync(
    containmentEvidencePath,
    JSON.stringify({ version: 1, pending: true, survivors: [] }),
    { flag: 'wx', mode: 0o600 }
  );
  const evidenceFd = openSync(containmentEvidencePath, 'r+');
  let child: ChildProcess;
  try {
    child = spawn(
      'python3',
      ['-c', LINUX_SUBREAPER_SUPERVISOR, command, ...args],
      {
        ...options,
        stdio: withContainmentEvidenceFd(options.stdio, evidenceFd),
      }
    );
  } catch (cause) {
    unlinkSync(containmentEvidencePath);
    throw cause;
  } finally {
    closeSync(evidenceFd);
  }
  let launchError: unknown;
  child.once('error', (cause) => {
    launchError = cause;
  });
  try {
    if (!child.pid) {
      await delay(0);
      throw new Error('Linux process supervisor did not start', {
        cause: launchError,
      });
    }
    const deadline = Date.now() + 5_000;
    while (readProcProcessIdentity(child.pid)?.state !== 'T') {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (existsSync(containmentEvidencePath)) {
          const result = JSON.parse(
            readFileSync(containmentEvidencePath, 'utf8')
          ) as { error?: unknown };
          if (typeof result.error === 'string') {
            throw new Error(`Linux launch containment failed: ${result.error}`);
          }
        }
        throw new Error('Linux launch containment exited before attachment');
      }
      if (Date.now() >= deadline) {
        throw new Error('Linux launch containment handshake timed out');
      }
      await delay(5);
    }
    const tracker = await trackProcessTreePromise(child);
    if (!tracker) throw new Error('Linux process tracker was not established');
    tracker.containmentEvidencePath = containmentEvidencePath;
    process.kill(child.pid, 'SIGCONT');
    return { child, tracker };
  } catch (cause) {
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch {}
    if (existsSync(containmentEvidencePath))
      unlinkSync(containmentEvidencePath);
    throw cause;
  }
}

async function findTrackedProcessSurvivorsPromise(
  tracker: ProcessTreeTracker | undefined,
  excludePids: readonly number[] = []
) {
  if (!tracker) return [];
  await tracker.pendingRefresh;
  if (tracker.refreshError) throw tracker.refreshError;
  await refreshProcessTreeTracker(tracker);
  if (tracker.containmentEvidenceError) {
    throw tracker.containmentEvidenceError;
  }
  const excluded = new Set(excludePids);
  return [...tracker.tracked.values()]
    .filter((identity) => {
      if (excluded.has(identity.pid)) return false;
      const currentIdentity = readProcProcessIdentity(identity.pid);
      return (
        currentIdentity?.startTime === identity.startTime &&
        currentIdentity.state !== 'Z' &&
        processExists(identity.pid)
      );
    })
    .map((identity) => identity.pid);
}

async function waitUntilGone(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (check() && Date.now() < deadline) await delay(50);
  return !check();
}

async function terminateTrackedPosixTree(tracker: ProcessTreeTracker) {
  if (tracker.interval) clearInterval(tracker.interval);
  await tracker.pendingRefresh;
  const cleanupErrors: unknown[] = [];
  if (tracker.refreshError) cleanupErrors.push(tracker.refreshError);
  if (tracker.containmentEvidenceError) {
    cleanupErrors.push(tracker.containmentEvidenceError);
  }

  try {
    await refreshProcessTreeTracker(tracker);
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  let protectedPids = new Set<number>();
  try {
    protectedPids = protectedHarnessPids(
      process.pid,
      await readPosixProcessTable()
    );
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  for (const identity of tracker.tracked.values()) {
    if (protectedPids.has(identity.pid)) {
      cleanupErrors.push(
        new Error(
          `Refusing to terminate protected harness PID: ${identity.pid}`
        )
      );
      continue;
    }
    if (readProcessStartTime(identity.pid) !== identity.startTime) continue;
    try {
      process.kill(identity.pid, 'SIGKILL');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
        cleanupErrors.push(cause);
      }
    }
  }
  const originalProcessesRemain = () =>
    [...tracker.tracked.values()].some((identity) => {
      const currentIdentity = readProcProcessIdentity(identity.pid);
      return (
        currentIdentity?.startTime === identity.startTime &&
        currentIdentity.state !== 'Z' &&
        processExists(identity.pid)
      );
    });
  if (!(await waitUntilGone(originalProcessesRemain, 4_000))) {
    const survivors = [...tracker.tracked.values()].filter((identity) => {
      const currentIdentity = readProcProcessIdentity(identity.pid);
      return (
        currentIdentity?.startTime === identity.startTime &&
        currentIdentity.state !== 'Z'
      );
    });
    cleanupErrors.push(
      new Error(
        `Tracked product processes survived cleanup: ${survivors
          .map((identity) => identity.pid)
          .join(', ')}`
      )
    );
  }

  tracker.refreshError = undefined;
  tracker.containmentEvidenceError = undefined;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'Process tree cleanup reported errors'
    );
  }
}

async function terminatePidTreePromise(pid: number) {
  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error(`Invalid product process PID: ${pid}`);
  }
  if (process.platform === 'win32') {
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
      throw new Error(`Product process tree survived taskkill: ${pid}`);
    }
    return;
  }

  if (!processExists(pid)) return;
  await terminateTrackedPosixTree(await trackPidTree(pid));
  if (!(await waitUntilGone(() => processExists(pid), 2_000))) {
    throw new Error(
      `Product process root was not reaped after cleanup: ${pid}`
    );
  }
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

async function terminate(child: ChildProcess, tracker?: ProcessTreeTracker) {
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

  const retainedTracker = tracker ?? trackedChildren.get(child);
  try {
    if (retainedTracker) {
      await terminateTrackedPosixTree(retainedTracker);
    } else {
      await terminatePidTreePromise(pid);
    }
    await waitForExit(child, 2_000);
  } finally {
    const evidencePath = retainedTracker?.containmentEvidencePath;
    if (evidencePath && existsSync(evidencePath)) unlinkSync(evidencePath);
    trackedChildren.delete(child);
  }
}

export const terminateProcessTree = (
  child: ChildProcess,
  tracker?: ProcessTreeTracker
) =>
  Effect.tryPromise({
    try: () => terminate(child, tracker),
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

export const trackProcessTree = (child: ChildProcess) =>
  Effect.tryPromise({
    try: () => trackProcessTreePromise(child),
    catch: (cause) =>
      new ProcessTreeTrackingError({
        operation: 'track',
        detail: `Could not track process tree for PID ${child.pid ?? 'unknown'}`,
        cause,
      }),
  });

export const spawnTrackedProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) =>
  Effect.tryPromise({
    try: () => spawnTrackedProcessPromise(command, args, options),
    catch: (cause) =>
      new ProcessTreeTrackingError({
        operation: 'spawn',
        detail: `Could not spawn and track ${[command, ...args].join(' ')}`,
        cause,
      }),
  });

export const findTrackedProcessSurvivors = (
  tracker: ProcessTreeTracker | undefined,
  excludePids: readonly number[] = []
) =>
  Effect.tryPromise({
    try: () => findTrackedProcessSurvivorsPromise(tracker, excludePids),
    catch: (cause) =>
      new ProcessTreeTrackingError({
        operation: 'inspect',
        detail: `Could not inspect tracked process tree for PID ${tracker?.rootPid ?? 'unknown'}`,
        cause,
      }),
  });

export const terminatePidTree = (pid: number) =>
  Effect.tryPromise({
    try: () => terminatePidTreePromise(pid),
    catch: (cause) =>
      cause instanceof ProcessTreeCleanupError
        ? cause
        : new ProcessTreeCleanupError({
            pid,
            platform: process.platform,
            detail: `Failed to remove process tree: ${(cause as Error).message}`,
            cause,
          }),
  }).pipe(
    Effect.timeoutFail({
      duration: '15 seconds',
      onTimeout: () =>
        new ProcessTreeCleanupError({
          pid,
          platform: process.platform,
          detail: 'Process tree cleanup exceeded 15 seconds',
        }),
    })
  );
