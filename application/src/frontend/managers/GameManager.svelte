<script lang="ts">
  import { gamesLaunched } from '../store';
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

  document.addEventListener('game:exit', (event: Event) => {
    const appID = (event as CustomEvent).detail.id;
    gamesLaunched.update((games) => {
      delete games[appID];
      return games;
    });
  });
</script>
