import type {
  ConfigurationFile,
  ConfigurationOptionWire,
} from '@ogi-sdk/connect';
import { AddonError, formatError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import {
  isBooleanOption,
  isNumberOption,
  isStringOption,
} from 'ogi-addon/config';
import {
  type AddonInfo,
  getAddonServer,
  queryConnectedAddons,
} from '@/frontend/lib/core/ipc';
import { runFrontendSync } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import type { AddonConfigValues } from '@/lib/state';

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

function defaultConfigValue(
  option: ConfigurationOptionWire
): number | boolean | string | undefined {
  if (isBooleanOption(option)) {
    return typeof option.defaultValue === 'boolean'
      ? option.defaultValue
      : false;
  }
  if (isNumberOption(option)) {
    return typeof option.defaultValue === 'number'
      ? option.defaultValue
      : (option.min ?? 0);
  }
  if (isStringOption(option)) {
    if (typeof option.defaultValue === 'string') {
      return option.defaultValue;
    }
    if ((option.allowedValues?.length ?? 0) > 0) {
      return option.allowedValues![0];
    }
    return '';
  }
  return undefined;
}

export function buildDefaultConfig(
  configTemplate: ConfigurationFile
): AddonConfigValues {
  const config: AddonConfigValues = {};
  for (const key in configTemplate) {
    const value = defaultConfigValue(configTemplate[key]);
    if (value !== undefined) {
      config[key] = value;
    }
  }
  return config;
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
