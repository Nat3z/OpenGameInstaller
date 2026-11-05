import { Data, Effect } from 'effect';

export type OGIConfig = {
  ignoredWatchFiles?: string[]; // paths relative to the addon root not to watch, e.g. `dist`
  addons?: string[]; // additional addons to install and load with a dev launch
};
export function defineConfig(config: OGIConfig) {
  return config;
}

class LoadConfigError extends Data.TaggedError('LoadConfigError') {}

export function loadConfigurator(
  path: string
): Effect.Effect<OGIConfig, LoadConfigError> {
  return Effect.gen(function* () {
    const config = yield* Effect.tryPromise({
      try: () => import(path),
      catch: () => new LoadConfigError(),
    });
    return config.default as OGIConfig;
  });
}
