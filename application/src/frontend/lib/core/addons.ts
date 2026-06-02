import type { LibraryInfo } from '@ogi-sdk/connect';
import { supportsStorefront } from '@/lib/storefronts';
import { addonServer, queryConnectedAddons, type AddonInfo } from './ipc';

export async function runLaunchAppAddons(
  libraryInfo: LibraryInfo,
  launchType: 'pre' | 'post'
) {
  const addons = (await queryConnectedAddons()).filter((addon) =>
    addon.eventsAvailable.includes('launch-app')
  );

  const results = await Promise.allSettled(
    addons.map((addon) =>
      addonServer.addon(addon.id).launchApp({
        libraryInfo,
        launchType,
      })
    )
  );

  const firstFailure = results.find((result) => result.status === 'rejected');
  if (firstFailure?.status === 'rejected') {
    throw firstFailure.reason;
  }

  return {
    success: true,
    results,
  };
}

export async function findAddonsSupportingStorefront(
  storefront: string,
  event: string
): Promise<AddonInfo[]> {
  return (await queryConnectedAddons()).filter(
    (addon) =>
      supportsStorefront(addon.storefronts as any, storefront) &&
      addon.eventsAvailable.includes(event)
  );
}
