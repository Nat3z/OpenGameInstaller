<script lang="ts">
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { getAllApps } from '@/frontend/lib/core/library';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import {
  createNotification,
  type GameRemovalTask,
  gameRemovalTasks,
  gamesLaunched,
} from '@/frontend/store.svelte';
import { runLaunchAppAddons } from '@/frontend/utils';

const logger = createLogger(LOGGER_PREFIXES.frontend);

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
    games[appID] = 'launching';
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

document.addEventListener('game:removal-progress', (event: Event) => {
  const payload = (event as CustomEvent).detail as Omit<
    GameRemovalTask,
    'timestamp'
  >;
  gameRemovalTasks.update((tasks) => {
    const existing = tasks.find((task) => task.id === payload.id);
    if (existing) {
      return tasks.map((task) =>
        task.id === payload.id ? { ...task, ...payload } : task
      );
    }
    return [...tasks, { ...payload, timestamp: Date.now() }];
  });
  if (payload.status === 'completed') {
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: `${payload.gameName} removed from library and files deleted`,
      type: 'success',
    });
  } else if (payload.status === 'error') {
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: `${payload.gameName} was removed from the library, but its files could not be deleted: ${payload.error}`,
      type: 'error',
    });
  }
});

document.addEventListener('game:exit', async (event: Event) => {
  const appID = (event as CustomEvent).detail.id;
  const isShortcutLaunch = isShortcutLaunchForGame(appID);

  try {
    // For Steam shortcut launches, unhide first so post-launch UI is visible.
    if (isShortcutLaunch) {
      await runFrontendEffect(electronRpc.app.showWindow());
    }
    // run the addon launch-app event with launchType 'post'
    let library = await getAllApps();
    const libraryInfo = library.find((app) => app.appID === appID);
    if (!libraryInfo) {
      logger.sync.error('Library info not found for appID: ' + appID);
      return;
    }

    await runFrontendEffect(runLaunchAppAddons(libraryInfo, 'post'));
  } catch (error) {
    logger.sync.error(error);
  } finally {
    gamesLaunched.update((games) => {
      delete games[appID];
      return games;
    });

    if (isShortcutLaunch) {
      await runFrontendEffect(electronRpc.app.close());
    }
  }
});
</script>
