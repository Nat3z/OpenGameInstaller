import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Data, Effect } from 'effect';

export type OGIConfig = {
  ignoredWatchFiles?: string[]; // paths relative to the addon root not to watch, e.g. `dist`
  addons?: string[]; // additional addons to install and load with a dev launch
} & (
  | {
      compile: true;
      author: string;
      iconPath?: string;
      // scripts receive the arguments forwarded by `ogi run <script> -- ...args`
      scripts: {
        preSetup?: (args: string[]) => Promise<void>;
        postSetup?: (args: string[]) => Promise<void>;
        setup?: (args: string[]) => Promise<void>;
        run: (args: string[]) => Promise<void>;
      };
    }
  | { compile?: false }
);
export function defineConfig(config: OGIConfig) {
  return config;
}

export class LoadConfigError extends Data.TaggedError('LoadConfigError')<{
  readonly message: string;
}> {}

const isStringArray = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.every((item) => typeof item === 'string'));

export function loadConfigurator(
  path: string
): Effect.Effect<OGIConfig, LoadConfigError> {
  return Effect.gen(function* () {
    // a file url, since import() reads a windows drive letter as a url scheme;
    // the query busts node's module cache, while bun needs the require.cache
    // entry (keyed by real path) dropped, so watch mode reloads edits on both
    const module = yield* Effect.tryPromise({
      try: () => {
        const absolute: string = realpathSync(resolve(path));
        delete createRequire(absolute).cache[absolute];
        const url: string = `${pathToFileURL(absolute).href}?t=${Date.now()}`;
        return import(url) as Promise<{ default?: unknown }>;
      },
      catch: (cause) =>
        new LoadConfigError({ message: `Failed to load ${path}: ${cause}` }),
    });
    const config = module.default as Partial<OGIConfig> | null | undefined;
    if (!config || typeof config !== 'object')
      return yield* new LoadConfigError({
        message: `${path} must default export a config`,
      });
    if (
      !isStringArray(config.addons) ||
      !isStringArray(config.ignoredWatchFiles)
    )
      return yield* new LoadConfigError({
        message: `${path}: addons and ignoredWatchFiles must be string arrays`,
      });
    return config as OGIConfig;
  });
}
