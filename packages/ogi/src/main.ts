#!/usr/bin/env node
import { styleText } from 'node:util';
import { Args, Command, Options } from '@effect/cli';
import { NodeContext, NodeRuntime } from '@effect/platform-node';
import { Console, Effect, Option } from 'effect';
import { version } from '../package.json';
import OgiMaker from './lib';
import dev from './modules/dev';
import { LaunchTool } from './modules/launch';

const port = Options.integer('port').pipe(Options.withDefault(7654));
const enforceSecurity = Options.boolean('enforce-security');
const securityKey = Options.text('security').pipe(Options.withDefault(''));
const from = Options.file('from', { exists: 'yes' }).pipe(
  Options.withDescription(
    'Local build (zip or AppImage) to launch instead of a release'
  ),
  Options.optional
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
  { securityKey, port, watch, from },
  ({ securityKey, port, watch, from }) =>
    dev({
      securityKey,
      port,
      entranceMessage,
      watch,
      from: Option.getOrUndefined(from),
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
    channel: Options.choice('channel', ['stable', 'unstable', 'nightly']).pipe(
      Options.withDescription(
        'Channel to update from when no version is given'
      ),
      Options.withDefault('stable')
    ),
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

const server = Command.make('server').pipe(
  Command.withSubcommands([serverStart])
);
const ogi = Command.make('ogi').pipe(
  // ogi dev, ogi server start, ogi start, ogi launch
  Command.withSubcommands([server, devStart, serverStart, launch])
);

Command.run(ogi, { name: 'ogi', version })(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  // @ogi-sdk/logger already prints logs, so skip effect's pretty logger
  NodeRuntime.runMain({ disablePrettyLogger: true })
);
