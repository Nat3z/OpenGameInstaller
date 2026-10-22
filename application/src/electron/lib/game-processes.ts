import type { ChildProcess } from 'node:child_process';
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
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
      logger.sync.warn(`[game] Failed to signal ${child.pid}:`, cause);
    }
    return false;
  }
}

/**
 * SIGTERM every running game, then SIGKILL whatever is left after
 * `timeoutMs`. Groups are polled rather than awaited on the leader's exit,
 * since umu-run can exit while wine processes are still shutting down.
 */
export async function terminateGameProcesses(timeoutMs: number): Promise<void> {
  terminating = true;
  const games = [...gameProcesses];
  if (games.length === 0) return;
  logger.sync.info(`[game] Terminating ${games.length} running game(s)`);
  for (const [child, processGroup] of games) {
    signalGame(child, processGroup, 'SIGTERM');
  }
  const deadline = Date.now() + timeoutMs;
  let alive = games;
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = alive.filter(([child, group]) => signalGame(child, group, 0));
  }
  for (const [child, processGroup] of alive) {
    logger.sync.warn(`[game] ${child.pid} ignored SIGTERM, sending SIGKILL`);
    signalGame(child, processGroup, 'SIGKILL');
  }
}
