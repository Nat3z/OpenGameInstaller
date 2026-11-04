import { cwd } from 'node:process';
import { styleText } from 'node:util';
import { FileSystem } from '@effect/platform';
import { PlatformError } from '@effect/platform/Error';
import { Addon } from '@ogi-sdk/executor';
import { Console, Duration, Effect } from 'effect';
import { Scope } from 'effect/Scope';
import OgiMaker from '../lib';
import { LaunchTool } from './launch';

type AddonJson = {
  scripts?: {
    preSetup?: string;
    postSetup?: string;
    setup?: string;
    run?: string;
  };
};
export default function DevCommand({
  securityKey,
  port,
  entranceMessage,
  watch,
  from,
}: {
  securityKey?: string;
  port: number;
  entranceMessage: (_: string) => Effect.Effect<void>;
  watch: boolean;
  /** Local build to launch instead of the newest stable release. */
  from?: string;
}) {
  return Effect.gen(function* () {
    yield* entranceMessage('dev');
    const fs = yield* FileSystem.FileSystem;
    const currentDir = cwd();

    // check first if the addon.json file exists
    const addonJsonPath = `${currentDir}/addon.json`;
    if (!(yield* fs.exists(addonJsonPath))) {
      yield* Console.error('Missing addon.json for addon entrypoint.');
      process.exit(1);
    }

    const packageJsonPath = `${currentDir}/package.json`;
    const packageJsonContent = yield* fs.readFileString(packageJsonPath);
    const packageJson = yield* Effect.try({
      try: () => JSON.parse(packageJsonContent) as { name?: string },
      catch: (error) => String(error),
    }).pipe(
      Effect.catchAll((error) =>
        Console.error('Failed to parse package.json:', error).pipe(
          Effect.as(undefined)
        )
      )
    );
    if (packageJson === undefined) {
      process.exit(1);
    }

    const addonJsonContent = yield* fs.readFileString(addonJsonPath);
    const addonJson = yield* Effect.try({
      try: () => JSON.parse(addonJsonContent) as AddonJson,
      catch: (error) => String(error),
    }).pipe(
      Effect.catchAll((error) =>
        Console.error('Failed to parse addon.json:', error).pipe(
          Effect.as(undefined)
        )
      )
    );
    if (addonJson === undefined) {
      process.exit(1);
    }

    const run = addonJson.scripts?.run;
    if (!run) {
      yield* Console.error('addon.json is missing scripts.run.');
      process.exit(1);
    }

    const addon = new Addon({
      port,
      secret: securityKey || 'f',
      name: packageJson.name || 'addon',
      path: currentDir,
      scripts: {
        run,
      },
    });

    function startAddon(): Effect.Effect<AbortController, Error, Scope> {
      return Effect.gen(function* () {
        const aborter = new AbortController();

        // start() resolves once the process spawns, so keep ogi alive until the
        // addon exits; the release kills it if ogi is interrupted (ctrl+c)
        yield* addon.start('inherit');
        const child = addon.getChildProcess();
        if (!child)
          return yield* Effect.fail(new Error('Missing child process'));

        aborter.signal.addEventListener('abort', () => {
          child.kill();
        });

        child.on('exit', (code) => {
          if (aborter.signal.aborted) return;
          process.exit(code);
        });

        return yield* Effect.succeed(aborter);
      });
    }

    // launch ogi gui for development, installing or updating stable if needed
    const launch = new LaunchTool();
    const tag = yield* launch.resolve({
      from,
      channel: 'stable',
      offline: false,
    });

    // host the addon server for the gui, listening before the addon connects
    const ogiBuilder = new OgiMaker();
    yield* Effect.promise(() => ogiBuilder.start(7654, false, 'f'));
    // closing the gui stops the addon and ends dev
    yield* launch
      .launch(
        tag,
        false, // no self-run server
        true // online is enabled
      )
      .pipe(
        // a gui killed by a signal fails instead of returning an exit code
        Effect.catchAll((error) =>
          Console.error(error.message).pipe(Effect.as(1))
        ),
        Effect.flatMap((code) =>
          addon.stop().pipe(
            Effect.ignore,
            Effect.andThen(() => process.exit(code))
          )
        ),
        Effect.fork
      );

    if (watch) {
      // watch when the addon changes (e.g., look for changes on disk)
      let controller: AbortController | undefined;

      // [file name]: file modification time
      let files: Record<string, number> = {};

      function fileMods(original: Record<string, number>) {
        return Effect.gen(function* () {
          const changes: `${'+' | '~'}${string}`[] = [];

          const files: Record<string, number> = {};
          function nest(
            dir: string
          ): Effect.Effect<void, PlatformError, Scope> {
            return Effect.gen(function* () {
              const entries = yield* fs.readDirectory(dir);
              for (const entry of entries) {
                if (entry.startsWith('node_modules') || entry.startsWith('.'))
                  continue;

                const stat = yield* fs.stat(`${dir}/${entry}`);
                // check if is directory
                if (stat.type === 'Directory') yield* nest(`${dir}/${entry}`);

                const key = `${dir}/${entry}`;
                if (stat.mtime._tag === 'Some') {
                  if (original[key] !== stat.mtime.value.getTime()) {
                    changes.push(`~${key}`);
                  } else if (!(key in original)) {
                    changes.push(`+${key}`);
                  }
                  files[key] = stat.mtime.value.getTime();
                }
              }
              return yield* Effect.succeed(void 0);
            });
          }
          yield* nest(currentDir);
          return yield* Effect.succeed({ files, changes });
        });
      }
      const result = yield* fileMods({});
      files = result.files;

      while (true) {
        if (controller && !controller.signal.aborted) {
          // look for changes on disk and mark as + or ~
          const { files: newFiles, changes } = yield* fileMods(files);
          files = newFiles;

          if (changes.length > 0) {
            // send a clear terminal ansi code
            yield* Console.log('\x1B[2J\x1B[0f');

            yield* Console.log(
              `Staged ${changes.length} change${changes.length !== 1 ? 's' : ''}`
            );
            for (const change of changes) {
              const ticker = change.at(0)! as '~' | '+';
              const str = change.slice(1).slice(currentDir.length + 1);
              yield* Console.log(
                styleText(
                  [ticker === '~' ? 'yellow' : 'green'],
                  ticker + ' ' + str
                )
              );
            }
            controller.abort('changes staged');
          }
          yield* Effect.sleep(Duration.millis(500));
          continue;
        }
        controller = yield* startAddon();
      }
    } else {
      yield* startAddon();
      // stay alive so the forked gui isn't interrupted
      yield* Effect.never;
    }
  }).pipe(Effect.scoped);
}
