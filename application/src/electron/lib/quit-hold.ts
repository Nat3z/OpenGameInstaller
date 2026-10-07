/**
 * Holds app quits while a game-launch flow (game + post-launch hooks) is
 * still running, so Steam stopping the game does not cut the hooks short.
 */
let held = false;
const waiters = new Set<() => void>();

export function setQuitHold(active: boolean): void {
  held = active;
  if (active) return;
  for (const waiter of waiters) waiter();
  waiters.clear();
}

export function isQuitHeld(): boolean {
  return held;
}

/** Resolves once the hold is released, or after `timeoutMs` regardless. */
export function waitForQuitRelease(timeoutMs: number): Promise<void> {
  if (!held) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      waiters.delete(finish);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    waiters.add(finish);
  });
}
