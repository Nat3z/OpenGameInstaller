import type { ConfigurationFile } from '@ogi-sdk/connect';
import { AddonError, formatError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import {
  type AddonInfo,
  getAddonServer,
  queryConnectedAddons,
} from '@/frontend/lib/core/ipc';
import { runFrontendSync } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import { buildDefaultConfig } from '@/lib/addon-config';

export { buildDefaultConfig };

const logger = createLogger(LOGGER_PREFIXES.frontend);

export interface ConfigTemplateAndInfo extends AddonInfo {
  configTemplate: ConfigurationFile;
}

export function validateAddonId(id: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    logger.sync.error(`Invalid addon id "${id}": rejected as a config key`);
    return null;
  }
  return id;
}

function waitForConfiguredAddons(maxWaitMs = 15_000, pollMs = 100) {
  return Effect.gen(function* () {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const addons = yield* queryConnectedAddons<ConfigTemplateAndInfo>();
      if (
        addons.length === 0 ||
        addons.every((addon) => addon.configTemplate !== undefined)
      ) {
        return addons;
      }
      yield* Effect.sleep(pollMs);
    }
    return yield* queryConnectedAddons<ConfigTemplateAndInfo>();
  });
}

function configureConnectedAddons() {
  return Effect.gen(function* () {
    const addons = yield* waitForConfiguredAddons();
    const results = yield* Effect.forEach(
      addons,
      (addon) =>
        Effect.gen(function* () {
          const safeId = validateAddonId(addon.id);
          if (!safeId || !addon.configTemplate) return;

          // First configuration seeds the addon's defaults so they show in settings.
          let config = yield* electronRpc.state.getAddonConfig(safeId).pipe(
            Effect.mapError(
              (cause) =>
                new AddonError({
                  message: `Failed to read addon configuration: ${formatError(cause)}`,
                  addonName: safeId,
                })
            )
          );
          if (!config) {
            config = buildDefaultConfig(addon.configTemplate);
            yield* electronRpc.state.setAddonConfig(safeId, config).pipe(
              Effect.mapError(
                (cause) =>
                  new AddonError({
                    message: `Failed to save addon configuration: ${formatError(cause)}`,
                    addonName: safeId,
                  })
              )
            );
          }

          const addonServer = yield* getAddonServer();
          yield* Effect.tryPromise({
            try: () =>
              addonServer
                .addon(safeId)
                .configUpdate(config as unknown as ConfigurationFile),
            catch: (cause) =>
              new AddonError({
                message: `Failed to configure addon: ${formatError(cause)}`,
                addonName: safeId,
              }),
          });
        }).pipe(Effect.either),
      { concurrency: 'unbounded' }
    );
    for (const result of results) {
      if (result._tag === 'Left') {
        logger.sync.error('Failed to configure addon:', result.left);
      }
    }
    return yield* queryConnectedAddons<ConfigTemplateAndInfo>();
  });
}

let configurationInFlight: ReturnType<typeof configureConnectedAddons> | null =
  null;

// Configuration is the addon runtime handshake: its first config-update emits connect.
export function fetchAddonsWithConfigure() {
  return Effect.suspend(() => {
    if (configurationInFlight) return configurationInFlight;

    const sharedConfiguration = runFrontendSync(
      Effect.cached(configureConnectedAddons())
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (configurationInFlight === sharedConfiguration) {
            configurationInFlight = null;
          }
        })
      )
    );
    configurationInFlight = sharedConfiguration;
    return sharedConfiguration;
  });
}
