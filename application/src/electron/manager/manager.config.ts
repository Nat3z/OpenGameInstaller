import { ConfigError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { __dirname } from '@/electron/manager/manager.paths.js';

const cachedValues: Record<string, Record<string, any>> = {};

export function getStoredValue(
  optionName: string,
  key: string
): Effect.Effect<any, ConfigError> {
  return Effect.gen(function* () {
    const addonPath = __dirname + '/config/option/' + optionName + '.json';
    const exists = yield* Effect.try({
      try: () => existsSync(addonPath),
      catch: (cause) =>
        new ConfigError({
          message: `Failed to inspect config option ${optionName}: ${String(cause)}`,
          key,
        }),
    });

    if (exists && !cachedValues[optionName]) {
      const selectedAddon = yield* Effect.tryPromise({
        try: () =>
          readFile(addonPath, 'utf-8').then((contents) => JSON.parse(contents)),
        catch: (cause) =>
          new ConfigError({
            message: `Failed to read config option ${optionName}: ${String(cause)}`,
            key,
          }),
      });
      cachedValues[optionName] = selectedAddon;
      return selectedAddon[key];
    }

    return cachedValues[optionName]?.[key];
  });
}

export function getSteamCompatibilityTool(): Effect.Effect<
  string,
  ConfigError
> {
  return Effect.gen(function* () {
    yield* refreshCached('general');
    const value: unknown = yield* getStoredValue(
      'general',
      'steamCompatibilityTool'
    );
    if (value === undefined) return 'proton_experimental';
    if (typeof value !== 'string') {
      return yield* Effect.fail(
        new ConfigError({
          message: 'Steam compatibility tool must be a string',
          key: 'steamCompatibilityTool',
        })
      );
    }
    return value.trim();
  });
}

export function refreshCached(
  optionName: string
): Effect.Effect<void, ConfigError> {
  return Effect.gen(function* () {
    const addonPath = __dirname + '/config/option/' + optionName + '.json';
    const exists = yield* Effect.try({
      try: () => existsSync(addonPath),
      catch: (cause) =>
        new ConfigError({
          message: `Failed to inspect config option ${optionName}: ${String(cause)}`,
          key: optionName,
        }),
    });

    if (exists) {
      const selectedAddon = yield* Effect.tryPromise({
        try: () =>
          readFile(addonPath, 'utf-8').then((contents) => JSON.parse(contents)),
        catch: (cause) =>
          new ConfigError({
            message: `Failed to refresh config option ${optionName}: ${String(cause)}`,
            key: optionName,
          }),
      });
      cachedValues[optionName] = selectedAddon;
    } else {
      delete cachedValues[optionName];
    }
  });
}
