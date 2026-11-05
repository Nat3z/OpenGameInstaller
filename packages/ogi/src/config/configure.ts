import { resolve } from 'node:path';
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

export class LoadConfigError extends Data.TaggedError('LoadConfigError') {}

export function loadConfigurator(
  path: string
): Effect.Effect<OGIConfig, LoadConfigError> {
  return Effect.gen(function* () {
    const resolvedPath = resolve(path);
    const config = yield* Effect.tryPromise({
      try: () => import(resolvedPath),
      catch: () => new LoadConfigError(),
    });
    return config.default as OGIConfig;
  });
}
