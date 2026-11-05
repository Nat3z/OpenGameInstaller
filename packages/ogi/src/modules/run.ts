import { Data, Effect } from 'effect';
import { type LoadConfigError, loadConfigurator } from '../config/configure';

export class RunCommandError extends Data.TaggedError('RunCommandError')<{
  readonly message: string;
}> {}

export default function RunCommand({
  script,
  args,
}: {
  script: string;
  args: string[];
}): Effect.Effect<void, RunCommandError | LoadConfigError> {
  return Effect.gen(function* () {
    const config = yield* loadConfigurator(`${process.cwd()}/ogi.config.js`);
    if (!config.compile)
      return yield* new RunCommandError({
        message: 'ogi.config.js does not declare any scripts',
      });

    // alias launch for `run` script cause imagine ogi run run...?
    if (script === 'launch') script = 'run';

    const scriptToRun = config.scripts[script as keyof typeof config.scripts];
    if (typeof scriptToRun !== 'function')
      return yield* new RunCommandError({
        message: `No script named "${script}" in ogi.config.js`,
      });

    // the async wrapper turns sync throws into rejections, so sync and async scripts both land in catch
    yield* Effect.tryPromise({
      try: async () => scriptToRun(args),
      catch: (error) =>
        new RunCommandError({
          message: error instanceof Error ? error.message : String(error),
        }),
    });
  });
}
