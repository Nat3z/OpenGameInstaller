import { Cause, Data, Effect, Exit } from 'effect';
import { replayRunEventLog } from './run-events';

class ReplayCommandError extends Data.TaggedError('ReplayCommandError')<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.detail;
  }
}

const path = process.argv[2];
const program = path
  ? Effect.try({
      try: () => replayRunEventLog(path),
      catch: (cause) =>
        new ReplayCommandError({
          detail: `Could not replay Run Event Log at ${path}`,
          cause,
        }),
    })
  : Effect.fail(
      new ReplayCommandError({
        detail: 'Usage: bun run replay -- /absolute/path/to/events.jsonl',
      })
    );
const exit = await Effect.runPromiseExit(program);
Exit.match(exit, {
  onFailure: (cause) => {
    console.error(Cause.pretty(cause));
    process.exitCode = 1;
  },
  onSuccess: (state) => {
    console.log(JSON.stringify(state, null, 2));
    process.exitCode = 0;
  },
});
