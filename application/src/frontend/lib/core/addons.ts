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

  const results = await Promise.all(
    addons.map((addon) =>
      addonServer.addon(addon.id).launchApp({
        libraryInfo,
        launchType,
      })
    )
  );

  return { success: true, results };
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
