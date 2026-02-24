<script lang="ts">
  import { getAllApps } from '../lib/core/library';
  import { gamesLaunched } from '../store';
  import { safeFetch } from '../utils';

  const launchParams = new URLSearchParams(window.location.search);
  const shortcutLaunchGameId = (() => {
    const launchGameId = launchParams.get('launchGameId');
    if (!launchGameId) return null;
    const parsed = parseInt(launchGameId, 10);
    return Number.isNaN(parsed) ? null : parsed;
  })();

  const isShortcutLaunchForGame = (appID: number) =>
    shortcutLaunchGameId !== null && shortcutLaunchGameId === appID;

  document.addEventListener('game:launch', (event: Event) => {
    const appID = (event as CustomEvent).detail.id;
    gamesLaunched.update((games) => {
      games[appID] = 'launched';
      return games;
    });

    if (isShortcutLaunchForGame(appID)) {
      window.electronAPI.app.hideWindow();
    }
  });

  document.addEventListener('game:launch-error', (event: Event) => {
    const appID = (event as CustomEvent).detail.id;
    gamesLaunched.update((games) => {
      delete games[appID];
      return games;
    });
  });

  document.addEventListener('game:exit', async (event: Event) => {
    const appID = (event as CustomEvent).detail.id;
    const isShortcutLaunch = isShortcutLaunchForGame(appID);

    try {
      // For Steam shortcut launches, unhide first so post-launch UI is visible.
      if (isShortcutLaunch) {
        await window.electronAPI.app.showWindow();
      }
      // run the addon launch-app event with launchType 'post'
      let library = await getAllApps();
      const libraryInfo = library.find((app) => app.appID === appID);
      if (!libraryInfo) {
        console.error('Library info not found for appID: ' + appID);
        return;
      }

      await safeFetch('launchApp', {
        libraryInfo: libraryInfo,
        launchType: 'post',
      });
    } catch (error) {
      console.error(error);
    } finally {
      gamesLaunched.update((games) => {
        delete games[appID];
        return games;
      });

      if (isShortcutLaunch) {
        await window.electronAPI.app.close();
      }
    }
  });
</script>
