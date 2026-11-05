#!/usr/bin/env node
import { styleText } from 'node:util';
import { Args, Command, Options } from '@effect/cli';
import { FileSystem } from '@effect/platform';
import { NodeContext, NodeRuntime } from '@effect/platform-node';
import { Console, Effect, Option } from 'effect';
import { version } from '../package.json';
import { CompileAddonJSON } from './config/compile';
import { loadConfigurator } from './config/configure';
import OgiMaker from './lib';
import dev from './modules/dev';
import { LaunchTool } from './modules/launch';
import run from './modules/run';

const port = Options.integer('port').pipe(Options.withDefault(7654));
const enforceSecurity = Options.boolean('enforce-security');
const securityKey = Options.text('security').pipe(Options.withDefault(''));
const from = Options.file('from', { exists: 'yes' }).pipe(
  Options.withDescription(
    'Local build (zip or AppImage) to launch instead of a release'
  ),
  Options.optional
);
const channel = Options.choice('channel', [
  'stable',
  'unstable',
  'nightly',
]).pipe(
  Options.withDescription('Channel to update from when no version is given'),
  Options.withDefault('stable')
);
const watch = Options.boolean('watch').pipe(
  Options.withAlias('w'),
  Options.withDefault(false)
);

const ogiBuilder = new OgiMaker();

const entranceMessage = (sub: string) =>
  Console.log(styleText(['bold', 'gray'], `ogi ${sub} (v${version})`));

// ogi dev
const devStart = Command.make(
  'dev',
  {
    securityKey,
    port,
    watch,
    from,
    channel,
    // --version is taken by @effect/cli's built-in version flag
    release: Options.text('release').pipe(
      Options.withDescription(
        'Release tag to launch, e.g. 4.3.4, nightly-<id> or local'
      ),
      Options.optional
    ),
  },
  ({ securityKey, port, watch, from, channel, release }) =>
    dev({
      securityKey,
      port,
      entranceMessage,
      watch,
      from: Option.getOrUndefined(from),
      version: Option.getOrUndefined(release),
      channel,
    })
);

// ogi server start
const serverStart = Command.make(
  'start',
  { port, enforceSecurity, securityKey },
  ({ port, enforceSecurity, securityKey }) =>
    Effect.gen(function* () {
      yield* entranceMessage('server start');
      yield* Effect.promise(() =>
        ogiBuilder.start(port, enforceSecurity, securityKey)
      );
    })
);

// ogi launch [version]
const launchTool = new LaunchTool();
const launch = Command.make(
  'launch',
  {
    version: Args.text({ name: 'version' }).pipe(
      Args.withDescription('Release tag to launch, e.g. 4.3.4 or nightly-<id>'),
      Args.optional
    ),
    channel,
    offline: Options.boolean('offline').pipe(
      Options.withDescription('Skip the update check and launch offline')
    ),
    from,
  },
  ({ version, channel, offline, from }) =>
    Effect.gen(function* () {
      yield* entranceMessage('launch');
      const tag = yield* launchTool.resolve({
        from: Option.getOrUndefined(from),
        version: Option.getOrUndefined(version),
        channel,
        offline,
      });
      yield* Console.log(styleText(['gray'], `Launching ${tag}`));
      const code = yield* launchTool.launch(tag, true, !offline);
      if (code !== 0) process.exitCode = code;
    }).pipe(
      // print the message alone instead of runMain's logged cause
      Effect.catchAll((error) =>
        Console.error(styleText(['red'], error.message)).pipe(
          Effect.andThen(() => {
            process.exitCode = 1;
          })
        )
      )
    )
);

// ogi run <script>
const runCommand = Command.make(
  'run',
  {
    script: Args.text({ name: 'script' }).pipe(
      Args.withDescription('The script to run')
    ),
    // anything after `--`, e.g. the --addonPort/--addonSecret the app appends
    args: Args.text({ name: 'args' }).pipe(
      Args.withDescription('Arguments forwarded to the script'),
      Args.repeated
    ),
  },
  ({ script, args }) =>
    Effect.gen(function* () {
      yield* entranceMessage('run');
      yield* run({ script, args }).pipe(
        Effect.andThen(() => {
          process.exit(0);
        }),
        Effect.catchAll((error) => {
          process.exitCode = 1;
          console.error(styleText(['red'], (error as unknown as Error).stack!));
          return Effect.void;
        })
      );
    })
);

// ogi build
const buildCommand = Command.make(
  'build',
  {
    config: Options.file('config').pipe(
      Options.withDefault('ogi.config.js'),
      Options.withDescription(
        'The build configuration file (defaults to ogi.config.js)'
      )
    ),
    allowedWriting: Options.boolean('write').pipe(
      Options.withDefault(false),
      Options.withDescription(
        'Allow writing to other files than the output addon.json'
      ),
      Options.withAlias('w')
    ),
  },
  ({ config, allowedWriting }) => {
    return Effect.gen(function* () {
      yield* entranceMessage('build');
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(config))) {
        yield* Console.log(
          styleText(['red'], `Configuration file not found: ${config}`)
        );
        process.exit(1);
      }
      // runMain doesn't report errors, so print why the config didn't load
      const ogiConfig = yield* loadConfigurator(config).pipe(
        Effect.catchAll((error) =>
          Console.error(styleText(['red'], error.message)).pipe(
            Effect.andThen(Effect.sync(() => process.exit(1)))
          )
        )
      );
      const compiler = new CompileAddonJSON(ogiConfig);
      return yield* compiler.compile(allowedWriting).pipe(
        Effect.andThen((result) => fs.writeFileString('addon.json', result)),
        Effect.catchAll((error) =>
          Console.error(styleText(['red'], error.stack!)).pipe(
            Effect.andThen(() => process.exit(1))
          )
        )
      );
    });
  }
);

const server = Command.make('server').pipe(
  Command.withSubcommands([serverStart])
);
const ogi = Command.make('ogi').pipe(
  // ogi dev, ogi server start, ogi start, ogi launch
  Command.withSubcommands([
    server,
    devStart,
    serverStart,
    launch,
    runCommand,
    buildCommand,
  ])
);

Command.run(ogi, { name: 'ogi', version })(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  // @ogi-sdk/logger already prints logs, so skip effect's pretty logger
  NodeRuntime.runMain({ disableErrorReporting: true })
);
