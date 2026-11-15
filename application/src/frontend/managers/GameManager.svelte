<script lang="ts">
import { Effect } from 'effect';
import { runDetached, runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import { gameRemovalTasks, gamesLaunched } from '@/frontend/store.svelte';
import type { GameRemovalProgress } from '@/lib/electron-rpc.js';

const launchParams = new URLSearchParams(window.location.search);
const shortcutLaunchGameId = (() => {
  const launchGameId = launchParams.get('launchGameId');
  if (!launchGameId) return null;
  const parsed = parseInt(launchGameId, 10);
  return Number.isNaN(parsed) ? null : parsed;
})();

const isShortcutLaunchForGame = (appID: number) =>
  shortcutLaunchGameId !== null && shortcutLaunchGameId === appID;

document.addEventListener('game:launch-requested', (event: Event) => {
  const appID = (event as CustomEvent).detail.id;
  gamesLaunched.update((games) => {
    // Events and launch changes arrive on separate feeds; a request that lands
    // after its own `game:launch` must not mark the running game as waiting.
    if (games[appID] !== 'launched') games[appID] = 'launching';
    return games;
  });
});

document.addEventListener('game:launch', (event: Event) => {
  const appID = (event as CustomEvent).detail.id;
  gamesLaunched.update((games) => {
    games[appID] = 'launched';
    return games;
  });

  if (isShortcutLaunchForGame(appID)) {
    runFrontendEffect(electronRpc.app.hideWindow());
  }
});

document.addEventListener('game:launch-error', (event: Event) => {
  const appID = (event as CustomEvent).detail.id;
  gamesLaunched.update((games) => {
    delete games[appID];
    return games;
  });
});

// Upserts a removal task from an IPC event or the startup snapshot. A terminal
// task is final: stale progress events queued during a reload are ignored. The
// main process sends the completion/failure notification itself.
function recordRemovalProgress(payload: GameRemovalProgress) {
  gameRemovalTasks.update((tasks) => {
    const existing = tasks.find((task) => task.id === payload.id);
    if (existing && existing.status !== 'running') return tasks;
    if (existing) {
      return tasks.map((task) =>
        task.id === payload.id ? { ...task, ...payload } : task
      );
    }
    return [...tasks, { ...payload, timestamp: Date.now() }];
  });
}

document.addEventListener('game:removal-progress', (event: Event) => {
  recordRemovalProgress((event as CustomEvent).detail as GameRemovalProgress);
});

// Deletions that started or finished before this renderer loaded (e.g. a
// reload mid-removal) only live in the main process; pull them in so the
// Tasks view survives.
runDetached(
  electronRpc.app.getRemovalTasks().pipe(
    Effect.map((tasks) => {
      for (const task of tasks) recordRemovalProgress(task);
    })
  ),
  'Failed to load pending game removals'
);

// The main process runs every session's post hooks and frees the game (the
// window may be gone by then), so the window only clears its state. A quit
// waits for those hooks.
document.addEventListener('game:exit', (event: Event) => {
  const appID = (event as CustomEvent).detail.id as number;
  gamesLaunched.update((games) => {
    delete games[appID];
    return games;
  });
  // Unhidden so a post hook's form has somewhere to show.
  if (isShortcutLaunchForGame(appID))
    runDetached(electronRpc.app.showWindow(), 'Failed to show the window');
});

// A Steam shortcut's window is done once its session's post hooks are.
document.addEventListener('game:session-ended', (event: Event) => {
  const appID = (event as CustomEvent).detail.id as number;
  if (isShortcutLaunchForGame(appID))
    runDetached(electronRpc.app.close(), 'Failed to close the window');
});
</script>
