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

const logger = createLogger(LOGGER_PREFIXES.frontend);

export interface ConfigTemplateAndInfo extends AddonInfo {
  configTemplate: ConfigurationFile;
}

export function validateAddonId(id: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    logger.sync.error(`Invalid addon id "${id}": rejected for path safety`);
    return null;
  }
  return id;
}

function addonConfigPath(addonId: string): string {
  return `./config/${addonId}.json`;
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

function buildDefaultConfig(
  configTemplate: ConfigurationFile
): Record<string, number | boolean | string> {
  const config: Record<string, number | boolean | string> = {};
  for (const key in configTemplate) {
    const value = defaultConfigValue(configTemplate[key]);
    if (value !== undefined) {
      config[key] = value;
    }
  }
  return config;
}

export function getConfigClientOption<T>(id: string): T | null {
  const safeId = validateAddonId(id);
  if (!safeId) return null;
  if (!window.electronAPI.fs.exists('./config/option/' + safeId + '.json'))
    return null;
  const config = window.electronAPI.fs.read(
    './config/option/' + safeId + '.json'
  );
  return JSON.parse(config) as T;
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

          const configPath = addonConfigPath(safeId);
          let config: Record<string, number | boolean | string>;
          if (!window.electronAPI.fs.exists(configPath)) {
            config = buildDefaultConfig(addon.configTemplate);
            window.electronAPI.fs.write(
              configPath,
              JSON.stringify(config, null, 2)
            );
          } else {
            config = yield* Effect.try({
              try: () => {
                const parsed: unknown = JSON.parse(
                  window.electronAPI.fs.read(configPath)
                );
                if (typeof parsed !== 'object' || parsed === null) {
                  throw new Error('Expected addon configuration object');
                }
                return parsed as Record<string, number | boolean | string>;
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.catchAll(() =>
                Effect.sync(() => {
                  const defaults = buildDefaultConfig(addon.configTemplate);
                  window.electronAPI.fs.write(
                    configPath,
                    JSON.stringify(defaults, null, 2)
                  );
                  return defaults;
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
