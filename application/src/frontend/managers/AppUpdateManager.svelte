<script lang="ts">
import { formatError, UpdateError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { Effect } from 'effect';
import core from '@/frontend/lib/core';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { updatesManager } from '@/frontend/states.svelte';
import {
  addonServer,
  fetchAddonsWithConfigure,
  isAddonEventAvailable,
  queryConnectedAddons,
  reconnectClientSdk,
} from '@/frontend/utils';
import { supportsStorefront } from '@/lib/storefronts';

const logger = createLogger(LOGGER_PREFIXES.frontend);

let updateCheckRunId = 0;

document.addEventListener('addon-runtime-ready', () => {
  void onAddonRuntimeReady();
});

async function onAddonRuntimeReady() {
  await runFrontendEffect(
    Effect.gen(function* () {
      yield* reconnectClientSdk();
      yield* fetchAddonsWithConfigure();
      yield* checkForAppUpdates();
    }).pipe(
      Effect.catchAll((error) =>
        logger.error(
          'Failed to refresh addon runtime for update checks:',
          error
        )
      )
    )
  );
}

function checkForAppUpdates() {
  const runId = ++updateCheckRunId;
  updatesManager.clearAppUpdates();
  logger.sync.info('checking for app updates');

  const workflow = Effect.gen(function* () {
    const library = yield* Effect.tryPromise({
      try: () => core.library.getAllApps(),
      catch: (cause) =>
        new UpdateError({
          message: `Failed to load library: ${formatError(cause)}`,
        }),
    });
    const connectedAddons = yield* queryConnectedAddons();
    yield* Effect.forEach(
      library,
      (app) =>
        Effect.gen(function* () {
          const addons = connectedAddons.filter(
            (addon) =>
              supportsStorefront(addon.storefronts, app.storefront) &&
              isAddonEventAvailable(addon, 'check-for-updates')
          );
          if (addons.length === 0) return;
          if (addons.length > 1) {
            return yield* Effect.fail(
              new UpdateError({
                message: 'Multiple clients found to serve this storefront',
              })
            );
          }
          const update = yield* Effect.tryPromise({
            try: () =>
              addonServer.addon(addons[0].id).checkForUpdates({
                appID: app.appID,
                storefront: app.storefront,
                currentVersion: app.version,
              }) as Promise<{ available: boolean; version: string }>,
            catch: (cause) =>
              new UpdateError({
                message: `Failed to check for updates: ${formatError(cause)}`,
              }),
          });
          if (runId === updateCheckRunId && update.available) {
            updatesManager.addAppUpdate({
              appID: app.appID,
              name: app.name,
              updateAvailable: true,
              updateVersion: update.version,
            });
          }
        }).pipe(
          Effect.catchAll((error) =>
            logger.error('Error checking for updates for app', app.name, error)
          )
        ),
      { concurrency: 4 }
    );
  });

  return workflow;
}
</script>
