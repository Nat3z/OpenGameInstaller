import core from '../core';
import { tryCatch } from '../core/tryCatch';
import { appUpdates, updatesManager } from '../../states.svelte';

/**
 * Runs the game update check for all library apps: clears current update state,
 * then for each app calls the addon check-for-updates procedure and records
 * available updates. Used by both startup (AppUpdateManager) and the manual
 * "Check for updates" action in the Library.
 *
 * @returns Promise resolving to { updatesFound } after all checks complete.
 */
export async function checkGameUpdates(): Promise<{
  updatesFound: number;
}> {
  updatesManager.clearAppUpdates();
  const library = await core.library.getAllApps();

  const promises = library.map((app) =>
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
    })
  );

  await Promise.all(promises);
  return { updatesFound: appUpdates.apps.length };
}
