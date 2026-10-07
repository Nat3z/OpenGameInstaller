import type { LibraryInfo, OGIAddonSDKEventListener } from '@ogi-sdk/connect';
import { AddonError, FileSystemError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import * as fs from 'fs/promises';
import { restartAddonServer } from '@/electron/handlers/handler.addon.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { getAddonServer } from '@/electron/server/addon-server.js';
import { Database, Settings } from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

export type DeleteInstalledAddonResult = {
  success: boolean;
  message?: string;
};

export type RunLaunchAppHooksResult = {
  success: boolean;
  error?: string;
};

export function isAddonEventAvailable(
  client: { eventsAvailable?: OGIAddonSDKEventListener[] } | undefined,
  event: OGIAddonSDKEventListener
): boolean {
  return client?.eventsAvailable?.includes(event) === true;
}

export function deleteInstalledAddon(
  addonID: string
): Effect.Effect<
  DeleteInstalledAddonResult,
  FileSystemError | AddonError,
  Settings | Database
> {
  return Effect.gen(function* () {
    const client = getAddonServer().getClient(addonID);
    if (!client) {
      return { success: false, message: 'Client not found' };
    }
    if (!client.addonInfo) {
      return { success: false, message: 'Client has no addon info' };
    }
    if (!client.addonLink || client.addonLink.startsWith('local@')) {
      return {
        success: false,
        message:
          'Addon was not spawned by OpenGameInstaller or is a "local@..." addon.',
      };
    }

    // Unlink and forget the addon in one transaction, keeping what was removed
    // so a failed folder removal below can put it back.
    const database = yield* Database;
    const previous = yield* database
      .transaction((db) => {
        const { addons } = db.getSettings();
        const config = db.getAddonConfig(addonID);
        db.updateSettings({
          addons: addons.filter((addon) => addon !== client.addonLink),
        });
        db.deleteAddonConfig(addonID);
        return { addons, config };
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new FileSystemError({
              message: `Failed to update addon configuration: ${String(cause)}`,
              cause,
            })
        )
      );

    yield* restartAddonServer();
    yield* Effect.sleep('1 second');

    const removed = yield* Effect.tryPromise({
      try: () => fs.rm(client.filePath!!, { recursive: true, force: true }),
      catch: (cause) =>
        new FileSystemError({
          message: `Failed to remove addon ${addonID}: ${String(cause)}`,
          path: client.filePath,
          cause,
        }),
    }).pipe(
      Effect.as(true),
      Effect.catchAll((error) =>
        logger
          .error('Failed to remove addon from addons folder', error)
          .pipe(Effect.as(false))
      )
    );

    if (removed) {
      yield* logger.info('Addon removed from addons folder');
      return { success: true };
    }
    // The folder is still there, so keep it linked and configured.
    yield* database
      .transaction((db) => {
        db.updateSettings({ addons: previous.addons });
        if (previous.config) db.setAddonConfig(addonID, previous.config);
      })
      .pipe(
        Effect.catchAll((error) =>
          logger.error('Failed to restore addon after removal failed', error)
        )
      );
    yield* restartAddonServer();
    return { success: false, message: 'Failed to remove addon' };
  });
}

export function runLaunchAppHooks(
  libraryInfo: LibraryInfo,
  launchType: 'pre' | 'post'
): Effect.Effect<RunLaunchAppHooksResult> {
  const clientsWithEvent = Array.from(
    getAddonServer().getConnections().values()
  ).filter((client) => isAddonEventAvailable(client, 'launch-app'));

  if (clientsWithEvent.length === 0) {
    return Effect.succeed({ success: true });
  }

  return Effect.gen(function* () {
    const results = yield* Effect.forEach(
      clientsWithEvent,
      (client) =>
        client.events.launchApp({ libraryInfo, launchType }).pipe(
          Effect.mapError(
            (cause) =>
              new AddonError({
                message: `Launch hook failed: ${String(cause)}`,
                addonName: client.addonInfo?.name,
              })
          ),
          Effect.either
        ),
      { concurrency: 'unbounded' }
    );
    const failure = results.find((result) => result._tag === 'Left');
    return failure?._tag === 'Left'
      ? { success: false, error: failure.left.message }
      : { success: true };
  });
}
