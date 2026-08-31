import type { LibraryInfo, OGIAddonSDKEventListener } from '@ogi-sdk/connect';
import { AddonError, formatError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { fetchAddonsWithConfigure } from '@/frontend/lib/config/client';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import { supportsStorefront } from '@/lib/storefronts';
import { type AddonInfo, getAddonServer, queryConnectedAddons } from './ipc';

export function installAddonsAndReconnect(addons: string[]) {
  return Effect.gen(function* () {
    yield* electronRpc.installAddons(addons);
    return yield* fetchAddonsWithConfigure();
  });
}

export function isAddonEventAvailable(
  addon: Pick<AddonInfo, 'eventsAvailable'> | undefined,
  event: OGIAddonSDKEventListener
): boolean {
  return addon?.eventsAvailable?.includes(event) === true;
}

export function getAddonIfEventAvailable(
  addonID: string,
  event: OGIAddonSDKEventListener
) {
  return queryConnectedAddons().pipe(
    Effect.map((addons) =>
      addons.find(
        (addon) => addon.id === addonID && isAddonEventAvailable(addon, event)
      )
    )
  );
}

function runLaunchAppAddonsOnce(
  libraryInfo: LibraryInfo,
  launchType: 'pre' | 'post'
) {
  return Effect.gen(function* () {
    yield* electronRpc.ensureAddonsSpawned();
    const addons = (yield* fetchAddonsWithConfigure()).filter((addon) =>
      isAddonEventAvailable(addon, 'launch-app')
    );
    const addonServer = yield* getAddonServer();
    const results = yield* Effect.forEach(
      addons,
      (addon) =>
        Effect.tryPromise({
          try: () =>
            addonServer.addon(addon.id).launchApp({ libraryInfo, launchType }),
          catch: (cause) =>
            new AddonError({
              message: `Launch hook failed: ${formatError(cause)}`,
              addonName: addon.name,
            }),
        }).pipe(Effect.either),
      { concurrency: 'unbounded' }
    );
    const failure = results.find((result) => result._tag === 'Left');
    return failure?._tag === 'Left'
      ? ({ success: false, error: failure.left } as const)
      : ({ success: true } as const);
  });
}

export function runLaunchAppAddons(
  libraryInfo: LibraryInfo,
  launchType: 'pre' | 'post'
) {
  return runLaunchAppAddonsOnce(libraryInfo, launchType).pipe(
    Effect.catchTag('AddonError', () =>
      Effect.gen(function* () {
        yield* electronRpc.restartAddonServer();
        return yield* runLaunchAppAddonsOnce(libraryInfo, launchType);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AddonError({
              message: `Failed to recover the addon runtime: ${formatError(cause)}`,
            })
        )
      )
    )
  );
}

export function findAddonsSupportingStorefront(
  storefront: string,
  event: OGIAddonSDKEventListener
) {
  return queryConnectedAddons().pipe(
    Effect.map((addons) =>
      addons.filter(
        (addon) =>
          supportsStorefront(
            addon.storefronts as readonly string[] | undefined,
            storefront
          ) && isAddonEventAvailable(addon, event)
      )
    )
  );
}
