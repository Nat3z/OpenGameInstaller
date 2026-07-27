<script lang="ts">
import { UpdateError } from '@ogi/errors';
import { Effect } from 'effect';
import core from '@/frontend/lib/core';
import { updatesManager } from '@/frontend/states.svelte';
import {
  addonServer,
  fetchAddonsWithConfigure,
  findAddonsSupportingStorefront,
  reconnectClientSdk,
} from '@/frontend/utils';

let updateCheckRunId = 0;

document.addEventListener('addon-runtime-ready', () => {
  void onAddonRuntimeReady();
});

async function onAddonRuntimeReady() {
  try {
    await reconnectClientSdk();
    await fetchAddonsWithConfigure();
    await checkForAppUpdates();
  } catch (error) {
    console.error('Failed to refresh addon runtime for update checks:', error);
  }
}

async function checkForAppUpdates() {
  let library;
  let runId;
  try {
    runId = ++updateCheckRunId;
    // clear the app updates every time the addon runtime comes up, then repopulate
    updatesManager.clearAppUpdates();
    console.log('checking for app updates');
    library = await core.library.getAllApps();
  } catch (error) {
    console.error('Failed to initialize app update check:', error);
    return;
  }
  for (const app of library) {
    Effect.runPromise(
      Effect.either(
        Effect.tryPromise({
          try: async () => {
            const addons = await findAddonsSupportingStorefront(
              app.storefront,
              'check-for-updates'
            );
            if (addons.length === 0) return undefined;
            if (addons.length > 1) {
              return await Effect.runPromise(
                Effect.fail(
                  new UpdateError({
                    message: 'Multiple clients found to serve this storefront',
                  })
                )
              );
            }
            const update = (await addonServer
              .addon(addons[0].id)
              .checkForUpdates({
                appID: app.appID,
                storefront: app.storefront,
                currentVersion: app.version,
              })) as { available: boolean; version: string };
            if (update.available) {
              return { available: true, version: update.version };
            }
            return undefined;
          },
          catch: (cause) => cause,
        })
      )
    ).then((result) => {
      if (runId !== updateCheckRunId) return;

      if (result._tag === 'Left') {
        console.error(
          'Error checking for updates for app',
          app.name,
          result.left
        );
      } else if (result.right !== undefined) {
        updatesManager.addAppUpdate({
          appID: app.appID,
          name: app.name,
          updateAvailable: result.right.available,
          updateVersion: result.right.version,
        });
      }
    });
  }
}
</script>
