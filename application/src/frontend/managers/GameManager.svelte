<script lang="ts">
  import { getAllApps } from '../lib/core/library';
  import { gamesLaunched } from '../store';
  import { safeFetch } from '../utils';
  document.addEventListener('game:launch', (event: Event) => {
    const appID = (event as CustomEvent).detail.id;
    gamesLaunched.update((games) => {
      games[appID] = 'launched';
      return games;
    });
  });

  document.addEventListener('game:launch-error', (event: Event) => {
    const appID = (event as CustomEvent).detail.id;
    gamesLaunched.update((games) => {
      delete games[appID];
      return games;
    });
  });

  document.addEventListener('game:exit', async (event: Event) => {
    // run the addon launch-app event with launchType 'post'
    let library = await getAllApps();
    const libraryInfo = library.find(
      (app) => app.appID === (event as CustomEvent).detail.id
    );
    if (!libraryInfo) {
      console.error(
        'Library info not found for appID: ' + (event as CustomEvent).detail.id
      );
      return;
    }

    try {
      await safeFetch('launchApp', {
        libraryInfo: libraryInfo,
        launchType: 'post',
      });
    } catch (error) {
      console.error(error);
    }

    // remove the game from the gamesLaunched state
    gamesLaunched.update((games) => {
      delete games[libraryInfo.appID];
      return games;
    });
  });
</script>
