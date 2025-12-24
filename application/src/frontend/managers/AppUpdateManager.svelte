<script lang="ts">
  import core from '../lib/core';
  import { tryCatch } from '../lib/core/tryCatch';
  import { updatesManager } from '../states.svelte';

  document.addEventListener('all-addons-started', () => {
    checkForAppUpdates();
    console.log('checking for app updates');
  });

  async function checkForAppUpdates() {
    const library = await core.library.getAllApps();
    for (const app of library) {
      tryCatch(async () => {
        const update: { available: boolean; version: string } =
          await core.ipc.safeFetch('checkForUpdates', {
            appID: app.appID,
            storefront: app.storefront,
            currentVersion: app.version,
          });
        if (update.available) {
          return { available: true, version: update.version };
        }
        return undefined;
      }).then((result) => {
        if (result.error !== null) {
          console.error(
            'Error checking for updates for app',
            app.name,
            result.error
          );
        } else if (result.data !== undefined) {
          updatesManager.addAppUpdate({
            appID: app.appID,
            name: app.name,
            updateAvailable: result.data.available,
            updateVersion: result.data.version,
          });
        }
      });
    }
  }
</script>
