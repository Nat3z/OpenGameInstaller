import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';

const logger = createLogger(LOGGER_PREFIXES.electron);

/**
 * Game processes OGI launched, mapped to whether each leads its own process
 * group (detached launches). A group is signalled as a whole so the full
 * umu/proton/wine tree goes down, not just the launcher.
 */
const gameProcesses = new Map<ChildProcess, boolean>();
// Set once shutdown starts; a game spawned after that is killed on sight.
let terminating = false;
// Set once a game ran this session, so its post-launch hooks are owed.
let launchedGame = false;

export function hasLaunchedGame(): boolean {
  return launchedGame;
}

export function trackGameProcess(
  child: ChildProcess,
  processGroup: boolean
): void {
  if (child.pid === undefined) return;
  if (terminating) {
    logger.sync.warn(`[game] ${child.pid} started during shutdown, killing`);
    signalGame(child, processGroup, 'SIGKILL');
    return;
  }
  launchedGame = true;
  gameProcesses.set(child, processGroup);
  if (!processGroup) {
    child.once('exit', () => gameProcesses.delete(child));
    return;
  }
  // A group can outlive its leader, so it is only retired once empty; its id
  // could otherwise be reused by an unrelated group and signalled later.
  child.once('exit', () => {
    const poll = setInterval(() => {
      if (signalGame(child, true, 0)) return;
      clearInterval(poll);
      gameProcesses.delete(child);
    }, 1_000);
    poll.unref();
  });
}

/** Signal a game; false once nothing is left to signal. */
function signalGame(
  child: ChildProcess,
  processGroup: boolean,
  signal: NodeJS.Signals | 0
): boolean {
  if (child.pid === undefined) return false;
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (!processGroup && exited) return false;
  try {
    process.kill(processGroup ? -child.pid : child.pid, signal);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // EPERM means something in the group is still alive, just not ours to signal.
    if (code === 'EPERM') return true;
    if (code !== 'ESRCH') {
      logger.sync.warn(`[game] Failed to signal ${child.pid}:`, cause);
    }
    return false;
  }
}

type ProcessTable = Map<number, { ppid: number; start: string }>;

/** Parent pid and start time of every process; empty off Linux. */
function readProcesses(): ProcessTable {
  const table: ProcessTable = new Map();
  if (process.platform !== 'linux') return table;
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    // Without /proc only the tracked launchers are signalled.
    return table;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      // comm can hold spaces and parens, so fields are counted after its `)`.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      table.set(Number(entry), { ppid: Number(fields[1]), start: fields[19] });
    } catch {
      // Exited while being read.
    }
  }
  return table;
}

/** Tree entries still running as the same process, by start time. */
function liveInTree(tree: Map<number, string>, table: ProcessTable): number[] {
  return [...tree].flatMap(([pid, start]) =>
    table.get(pid)?.start === start ? [pid] : []
  );
}

/** Adds every live descendant of the tree's live processes to it. */
function extendTree(tree: Map<number, string>): void {
  const table = readProcesses();
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) {
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  const queue = liveInTree(tree, table);
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (tree.has(child)) continue;
      tree.set(child, table.get(child)!.start);
      queue.push(child);
    }
  }
}

/** Signals the tree's processes that are still the ones it recorded. */
function killTree(tree: Map<number, string>, signal: NodeJS.Signals): void {
  for (const pid of liveInTree(tree, readProcesses())) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * SIGTERM every running game, then SIGKILL whatever is left after
 * `timeoutMs`. umu-run starts proton in a session of its own, so its group
 * alone misses wine; the tree under each game is also walked by parent links
 * (umu-run is a subreaper, so it holds every descendant while alive) and
 * killed by pid, with start times guarding against reused pids.
 */
export async function terminateGameProcesses(timeoutMs: number): Promise<void> {
  terminating = true;
  const games = [...gameProcesses];
  if (games.length === 0) return;
  logger.sync.info(`[game] Terminating ${games.length} running game(s)`);
  const table = readProcesses();
  const tree = new Map<number, string>();
  for (const [child] of games) {
    // An exited leader's pid may already belong to an unrelated process.
    if (child.pid === undefined || child.exitCode !== null) continue;
    if (child.signalCode !== null) continue;
    const entry = table.get(child.pid);
    if (entry) tree.set(child.pid, entry.start);
  }
  // Walked before SIGTERM, since a launcher exiting reparents its children.
  extendTree(tree);
  for (const [child, processGroup] of games) {
    signalGame(child, processGroup, 'SIGTERM');
  }
  killTree(tree, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  let alive = games;
  let survivors = liveInTree(tree, readProcesses());
  while ((alive.length > 0 || survivors.length > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = alive.filter(([child, group]) => signalGame(child, group, 0));
    survivors = liveInTree(tree, readProcesses());
  }
  if (alive.length === 0 && survivors.length === 0) return;
  // Walked again to catch anything spawned during the grace period.
  extendTree(tree);
  logger.sync.warn('[game] Games ignored SIGTERM, sending SIGKILL');
  killTree(tree, 'SIGKILL');
  for (const [child, processGroup] of alive) {
    signalGame(child, processGroup, 'SIGKILL');
  }
}
