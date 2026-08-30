<script lang="ts">
import { formatError, UpdateError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import core from '@/frontend/lib/core';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { updatesManager } from '@/frontend/states.svelte';
import {
  fetchAddonsWithConfigure,
  getAddonServer,
  isAddonEventAvailable,
  queryConnectedAddons,
} from '@/frontend/utils';
import { supportsStorefront } from '@/lib/storefronts';

const logger = createLogger(LOGGER_PREFIXES.frontend);

let updateCheckRunId = 0;

document.addEventListener('addon-manifests-ready', () => {
  void onAddonManifestsReady();
});

async function onAddonManifestsReady() {
  await runFrontendEffect(
    Effect.gen(function* () {
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
    const addonServer = yield* getAddonServer();
    const checkableApps = library
      .map((app) => ({
        app,
        addons: connectedAddons.filter(
          (addon) =>
            supportsStorefront(addon.storefronts, app.storefront) &&
            isAddonEventAvailable(addon, 'check-for-updates')
        ),
      }))
      .filter(({ addons }) => addons.length > 0);
    if (runId === updateCheckRunId) {
      updatesManager.setCheckingAppUpdates(
        checkableApps.map(({ app }) => app.appID)
      );
    }
    yield* Effect.forEach(
      checkableApps,
      ({ app, addons }) =>
        Effect.gen(function* () {
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
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (runId === updateCheckRunId) {
                updatesManager.finishAppUpdateCheck(app.appID);
              }
            })
          )
        ),
      { concurrency: 4 }
    );
  });

  return workflow.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        // if the whole run dies early (e.g. addon server unavailable),
        // never leave games stuck on the checking spinner
        if (runId === updateCheckRunId) {
          updatesManager.setCheckingAppUpdates([]);
        }
      })
    )
  );
}
</script>
