import type { LibraryInfo, OGIAddonSDKEventListener } from '@ogi-sdk/connect';
import { AddonError, FileSystemError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { readFileSync, writeFileSync } from 'fs';
import * as fs from 'fs/promises';
import { join } from 'path';
import { restartAddonServer } from '@/electron/handlers/handler.addon.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { addonServer } from '@/electron/server/addon-server.js';

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
): Effect.Effect<DeleteInstalledAddonResult, FileSystemError | AddonError> {
  return Effect.gen(function* () {
    const client = addonServer.getClient(addonID);
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

    const generalConfigPath = join(__dirname, 'config/option/general.json');
    yield* Effect.try({
      try: () => {
        const generalConfig = JSON.parse(
          readFileSync(generalConfigPath, 'utf-8')
        ) as { addons: string[] };
        generalConfig.addons = generalConfig.addons.filter(
          (addon) => addon !== client.addonLink
        );
        writeFileSync(
          generalConfigPath,
          JSON.stringify(generalConfig, null, 2)
        );
      },
      catch: (cause) =>
        new FileSystemError({
          message: `Failed to update addon configuration: ${String(cause)}`,
          path: generalConfigPath,
          cause,
        }),
    });

    yield* restartAddonServer();
    yield* Effect.sleep('1 second');

    const removals = yield* Effect.tryPromise({
      try: () =>
        Promise.allSettled([
          fs.rm(client.filePath!!, { recursive: true, force: true }),
          fs.rm(join(__dirname, 'config', addonID), {
            recursive: true,
            force: true,
          }),
        ]),
      catch: (cause) =>
        new FileSystemError({
          message: `Failed to remove addon ${addonID}: ${String(cause)}`,
          path: client.filePath,
          cause,
        }),
    });

    if (removals[0].status === 'fulfilled') {
      yield* logger.info('Addon removed from addons folder');
    } else {
      yield* logger.error(
        'Failed to remove addon from addons folder',
        removals[0].reason
      );
    }

    if (removals[1].status === 'fulfilled') {
      yield* logger.info('Addon removed from config folder');
    } else {
      yield* logger.error(
        'Failed to remove addon from config folder',
        removals[1].reason
      );
    }

    return removals[0].status === 'fulfilled'
      ? { success: true }
      : { success: false, message: 'Failed to remove addon' };
  });
}

export function runLaunchAppHooks(
  libraryInfo: LibraryInfo,
  launchType: 'pre' | 'post'
): Effect.Effect<RunLaunchAppHooksResult> {
  const clientsWithEvent = Array.from(
    addonServer.getConnections().values()
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
