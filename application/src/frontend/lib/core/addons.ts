import type { LibraryInfo, OGIAddonSDKEventListener } from '@ogi-sdk/connect';
import { supportsStorefront } from '@/lib/storefronts';
import { addonServer, queryConnectedAddons, type AddonInfo } from './ipc';

export function isAddonEventAvailable(
  addon: Pick<AddonInfo, 'eventsAvailable'> | undefined,
  event: OGIAddonSDKEventListener
): boolean {
  return addon?.eventsAvailable?.includes(event) === true;
}

export async function getAddonIfEventAvailable(
  addonID: string,
  event: OGIAddonSDKEventListener
): Promise<AddonInfo | undefined> {
  return (await queryConnectedAddons()).find(
    (addon) => addon.id === addonID && isAddonEventAvailable(addon, event)
  );
}

export async function runLaunchAppAddons(
  libraryInfo: LibraryInfo,
  launchType: 'pre' | 'post'
) {
  const addons = (await queryConnectedAddons()).filter((addon) =>
    isAddonEventAvailable(addon, 'launch-app')
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
      isAddonEventAvailable(addon, event as OGIAddonSDKEventListener)
  );
}
