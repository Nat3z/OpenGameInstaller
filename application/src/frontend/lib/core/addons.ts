import type { LibraryInfo, OGIAddonSDKEventListener } from '@ogi-sdk/connect';
import { AddonError, formatError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import { supportsStorefront } from '@/lib/storefronts';
import {
  type AddonInfo,
  addonServer,
  queryConnectedAddons,
  reconnectClientSdk,
} from './ipc';

export function installAddonsAndReconnect<T = AddonInfo>(addons: string[]) {
  return Effect.gen(function* () {
    yield* electronRpc.installAddons(addons);
    yield* reconnectClientSdk();
    return yield* queryConnectedAddons<T>();
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

export function runLaunchAppAddons(
  libraryInfo: LibraryInfo,
  launchType: 'pre' | 'post'
) {
  return Effect.gen(function* () {
    const addons = (yield* queryConnectedAddons()).filter((addon) =>
      isAddonEventAvailable(addon, 'launch-app')
    );
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
