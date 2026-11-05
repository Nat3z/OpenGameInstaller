import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { cwd } from 'node:process';
import { styleText } from 'node:util';
import { FileSystem } from '@effect/platform';
import { PlatformError } from '@effect/platform/Error';
import type { ReleaseChannel } from '@ogi/update-channel';
import { Addon, type AddonFileConfiguration } from '@ogi-sdk/executor';
import { Console, Deferred, Duration, Effect, Exit, Fiber } from 'effect';
import { Scope } from 'effect/Scope';
import { CompileAddonJSON } from 'src/config/compile';
import { loadConfigurator } from '../config/configure';
import OgiMaker from '../lib';
import { LaunchTool } from './launch';
import { LogViews } from './log-views';

export default function DevCommand({
  securityKey,
  port,
  entranceMessage,
  watch,
  from,
  version,
  channel,
}: {
  securityKey?: string;
  port: number;
  entranceMessage: (_: string) => Effect.Effect<void>;
  watch: boolean;
  /** Local build to launch instead of a release. */
  from?: string;
  /** Release tag to launch, e.g. `local` for the last `--from` build. */
  version?: string;
  /** Channel to take the newest release from when no version is given. */
  channel: ReleaseChannel;
}) {
  return Effect.gen(function* () {
    yield* entranceMessage('dev');
    const fs = yield* FileSystem.FileSystem;
    const currentDir = cwd();

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

    // validated against the executor's schema, so scripts.run is guaranteed
    const addonJson: AddonFileConfiguration =
      yield* Addon.Setup.loadAddonConfig(currentDir).pipe(
        Effect.catchAll((error) =>
          Console.error(error.message).pipe(
            Effect.andThen(Effect.sync(() => process.exit(1)))
          )
        )
      );

    // check if a configurator for builds with dev exists
    const configuratorPath = `${currentDir}/ogi.config.js`;

    let extraInfo = {
      addons: [] as string[],
      ignoredWatchFiles: [] as string[],
    };
    if (yield* fs.exists(configuratorPath)) {
      let loadedConfig = yield* loadConfigurator(configuratorPath);
      // compile with compiler first if 'compile' is set true
      if (loadedConfig.compile) {
        const compiler = new CompileAddonJSON(loadedConfig);
        yield* compiler.compile(false);
      }
      if (loadedConfig.addons) {
        extraInfo.addons = loadedConfig.addons;
      }
      if (loadedConfig.ignoredWatchFiles) {
        extraInfo.ignoredWatchFiles = loadedConfig.ignoredWatchFiles;
      }
    }

    const secret: string = securityKey || 'f';
    // get name of the parent directory for the addon
    const addonName = packageJson.name || basename(currentDir);
    const addon = new Addon({
      port,
      secret,
      name: addonName,
      path: currentDir,
      scripts: addonJson.scripts,
    });

    // pre-requisites get their own view so they don't bury the addon's logs
    const views = new LogViews(
      extraInfo.addons.length > 0
        ? ['addon', 'prereqs', 'app']
        : ['addon', 'app']
    );

    // pre-requisites are cached per project, keyed by a hash of its path
    const projectHash: string = createHash('sha256')
      .update(currentDir)
      .digest('hex');
    const addonsDirectory: string = join(
      homedir(),
      '.ogi',
      'cache',
      projectHash
    );
    // now, for each sideloaded addon, setup and build it
    let stagedAddons = yield* Effect.forEach(extraInfo.addons, (addonUrl) =>
      Effect.gen(function* () {
        const addonName: string = basename(addonUrl, '.git');
        const addonPath: string = join(addonsDirectory, addonName);

        const addonSetupTool = new Addon.Git({
          path: addonPath,
        });

        let needsReSetup = false;

        if (!(yield* fs.exists(addonPath))) {
          yield* Console.log(
            styleText(
              ['yellow', 'bold'],
              `Installing addon ${addonName} (${addonUrl})...`
            )
          );
          yield* fs.makeDirectory(addonsDirectory, {
            recursive: true,
          });
          yield* addonSetupTool.clone(addonUrl);
          needsReSetup = true;
        }
        // otherwise, update the addon
        else {
          // a failed pull (offline, dirty tree) keeps the current checkout
          const firstHash = yield* addonSetupTool.getCurrentHash();
          yield* addonSetupTool
            .pull()
            .pipe(
              Effect.catchAll((error) =>
                Console.warn(
                  styleText(
                    ['red', 'bold'],
                    `Couldn't update ${addonName}, using the current checkout: ${error.message}`
                  )
                )
              )
            );
          const secondHash = yield* addonSetupTool.getCurrentHash();
          needsReSetup = firstHash !== secondHash;
        }

        // validated addon.json, so scripts.run is guaranteed
        const { scripts } = yield* Addon.Setup.loadAddonConfig(addonPath);
        const addonToSetup = new Addon.Setup({
          path: addonPath,
          name: addonName,
          scripts,
        });
        // installation.log marks a finished setup, same as the app
        if (needsReSetup || !(yield* addonToSetup.isInstalled())) {
          yield* Console.log(
            styleText(['yellow', 'bold'], `Setting up addon ${addonName}...`)
          );
          yield* addonToSetup.runSetup();
        }

        return yield* Effect.succeed(
          new Addon({
            name: addonName,
            path: addonPath,
            port,
            scripts,
            secret,
          })
        );
      })
    );

    // aborting kills the running addon without ending dev
    let controller: AbortController | undefined;
    const stopAddon: Effect.Effect<void> = Effect.sync(() =>
      controller?.abort()
    ).pipe(Effect.andThen(addon.stop()), Effect.ignore);
    // pre-requisites only stop when dev ends, not on reloads
    // set once the gui launches, so an addon exit can close it
    let gui: Fiber.RuntimeFiber<unknown, unknown> | undefined;
    const stopAll: Effect.Effect<void> = stopAddon.pipe(
      Effect.andThen(
        Effect.forEach(stagedAddons, (prereq) => prereq.stop(), {
          discard: true,
        })
      ),
      Effect.ignore
    );
    // finalizers run in reverse, so on ctrl+c this runs after the gui closes
    yield* Effect.addFinalizer(() => stopAll);

    // addons start one at a time, so the next connection is the one just started
    let pendingConnection:
      | { path: string; connected: Deferred.Deferred<void> }
      | undefined;

    /**
     * Claims the next addon connection for `path`, so the gui can read its
     * addon.json (e.g. the icon). Wait on the result once the addon spawns.
     */
    function claimConnection(
      path: string
    ): Effect.Effect<(child: ChildProcess) => Effect.Effect<void>> {
      return Effect.gen(function* () {
        const connected = yield* Deferred.make<void>();
        pendingConnection = { path, connected };
        return (child: ChildProcess) => {
          // an addon that exits or never connects shouldn't hold up dev
          child.once('exit', () => Deferred.unsafeDone(connected, Exit.void));
          return Deferred.await(connected).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                if (pendingConnection?.connected === connected)
                  pendingConnection = undefined;
              })
            )
          );
        };
      });
    }

    // startAddon loop with abort controller when the addon is signaled to restart
    function startAddon(): Effect.Effect<AbortController, Error> {
      return Effect.gen(function* () {
        const aborter = new AbortController();
        const connected = yield* claimConnection(addon.config.path);
        // start() resolves once the process spawns, so keep ogi alive until the
        // addon exits
        yield* addon.start((data) => views.write('addon', data));
        const child = addon.getChildProcess();
        if (!child)
          return yield* Effect.fail(new Error('Missing child process'));

        aborter.signal.addEventListener('abort', () => {
          Addon.killProcessGroup(child);
          server.emit('notification', {
            message: 'Restarting Addon...',
            id: 'restart-addon-hmr',
            type: 'warning',
          });
        });

        child.on('exit', (code, signal) => {
          if (aborter.signal.aborted) return;
          // in watch mode, the next change restarts it
          if (watch) {
            views.write(
              'addon',
              styleText(
                ['red'],
                `Addon exited (${code ?? signal}), waiting for changes...\n`
              )
            );
            return;
          }
          // process.exit skips finalizers, so close the gui and clean up first
          Effect.runFork(
            Effect.suspend(() =>
              gui ? Fiber.interrupt(gui) : Effect.void
            ).pipe(
              Effect.andThen(stopAll),
              Effect.andThen(Effect.sync(() => process.exit(code ?? 1)))
            )
          );
        });

        yield* connected(child);
        return yield* Effect.succeed(aborter);
      });
    }

    // launch ogi gui for development, installing or updating the release if needed
    const launch = new LaunchTool();
    const tag = yield* launch.resolve({
      from,
      version,
      channel,
      offline: false,
    });

    // host the addon server for the gui, listening before the addon connects
    const ogiBuilder = new OgiMaker();
    const server = yield* Effect.promise(() =>
      ogiBuilder.start(port, false, secret)
    );
    server.on('connect', (connection) => {
      if (!pendingConnection) return;
      connection.filePath = pendingConnection.path;
      Deferred.unsafeDone(pendingConnection.connected, Exit.void);
      pendingConnection = undefined;
    });
    views.show('addon');
    // closing the gui stops the addon and ends dev; interrupting it kills the gui
    gui = yield* launch
      .launch(
        tag,
        false, // no self-run server
        true, // online is enabled
        true, // skip OOBE
        true, // load in dev mode
        (data) => views.write('app', data)
      )
      .pipe(
        // a gui killed by a signal fails instead of returning an exit code
        Effect.catchAll((error) =>
          Console.error(error.message).pipe(Effect.as(1))
        ),
        Effect.flatMap((code) =>
          stopAll.pipe(Effect.andThen(() => process.exit(code)))
        ),
        Effect.forkScoped
      );

    // ignored paths are relative to the addon root, e.g. `dist` or `src/generated`
    const ignoredWatchPaths: string[] = extraInfo.ignoredWatchFiles.map(
      (path) =>
        path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    );
    function isIgnored(path: string): boolean {
      const rel: string = relative(currentDir, path).split(sep).join('/');
      return ignoredWatchPaths.some(
        (ignored) => rel === ignored || rel.startsWith(`${ignored}/`)
      );
    }

    // watch when the addon changes (e.g., look for changes on disk)
    const watchAddon = Effect.gen(function* () {
      // [file name]: file modification time
      let files: Record<string, number> = {};

      function fileMods(original: Record<string, number>) {
        return Effect.gen(function* () {
          const changes: `${'+' | '~' | '-'}${string}`[] = [];

          const files: Record<string, number> = {};
          function nest(
            dir: string
          ): Effect.Effect<void, PlatformError, Scope> {
            return Effect.gen(function* () {
              const entries = yield* fs.readDirectory(dir);
              for (const entry of entries) {
                const key = `${dir}/${entry}`;
                if (
                  entry.startsWith('node_modules') ||
                  entry.startsWith('.') ||
                  isIgnored(key)
                )
                  continue;

                const stat = yield* fs.stat(key);
                // check if is directory
                if (stat.type === 'Directory') yield* nest(key);

                if (stat.mtime._tag === 'Some') {
                  if (
                    original[key] !== undefined &&
                    original[key] !== stat.mtime.value.getTime()
                  ) {
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
          for (const key of Object.keys(original))
            if (!(key in files)) changes.push(`-${key}`);

          return yield* Effect.succeed({ files, changes });
        });
      }
      const result = yield* fileMods({});
      files = result.files;

      while (true) {
        // look for changes on disk and mark as +, ~ or -
        if (controller && !controller.signal.aborted) {
          const { files: newFiles, changes } = yield* fileMods(files);
          files = newFiles;

          if (changes.length > 0) {
            views.clear('addon');
            views.write(
              'addon',
              `Staged ${changes.length} change${changes.length !== 1 ? 's' : ''}\n`
            );
            for (const change of changes) {
              const ticker = change.at(0)! as '~' | '+' | '-';
              const str = change.slice(1).slice(currentDir.length + 1);
              views.write(
                'addon',
                styleText(
                  [
                    ticker === '~'
                      ? 'yellow'
                      : ticker === '+'
                        ? 'green'
                        : 'red',
                  ],
                  ticker + ' ' + str
                ) + '\n'
              );

              if (str === 'ogi.config.js') {
                views.write(
                  'addon',
                  styleText(['green'], 'Recompiling ogi.config.js...\n')
                );
                // recompile on changes to ogi.config.js
                const loadedConfig = yield* loadConfigurator(configuratorPath);
                const compiler = new CompileAddonJSON(loadedConfig);
                yield* compiler
                  .compile(false)
                  .pipe(
                    Effect.andThen((s) =>
                      fs.writeFileString(`${currentDir}/addon.json`, s)
                    )
                  );
              }
            }
            controller.abort('changes staged');
          }

          // every 250ms check if there is a change staged
          yield* Effect.sleep(Duration.millis(250));
          continue;
        }
        controller = yield* startAddon();
      }
    });

    // start pre-requisite addons, waiting for each to connect
    // prefix each line, since every pre-requisite shares one view
    yield* Effect.forEach(
      stagedAddons,
      (prereq) =>
        Effect.gen(function* () {
          const connected = yield* claimConnection(prereq.config.path);
          yield* prereq.start((data) =>
            views.write(
              'prereqs',
              data
                .toString()
                .replace(
                  /^(?=.)/gm,
                  styleText(['gray'], `[${prereq.config.name}] `)
                )
            )
          );
          const child = prereq.getChildProcess();
          if (child) yield* connected(child);
        }),
      { discard: true }
    );

    // runs until ctrl+c, then the scope stops the gui and addon
    yield* Effect.raceFirst(
      watch
        ? watchAddon
        : startAddon().pipe(
            Effect.andThen((aborter) => {
              controller = aborter;
            }),
            Effect.andThen(Effect.never)
          ),
      views.keys()
    );
  }).pipe(
    Effect.scoped,
    // the addon server keeps the process alive, so exit once cleaned up
    Effect.andThen(() => process.exit(130))
  );
}
