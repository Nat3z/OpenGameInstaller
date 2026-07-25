import { Cause, Data, Effect, Exit } from 'effect';
import { createObserverServer } from './observer-server';

class ObserverCommandError extends Data.TaggedError('ObserverCommandError')<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.detail;
  }
}

const openWindow = !process.argv.slice(2).includes('--no-open');
const serverExit = await Effect.runPromiseExit(
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => createObserverServer({ openWindow }),
      catch: (cause) =>
        new ObserverCommandError({
          detail: 'Observer Window server failed to start',
          cause,
        }),
    }),
    (server) =>
      Effect.gen(function* () {
        console.log(`Observer Window: ${server.url}`);
        console.log(
          'Press Ctrl+C to stop the Observer server. Active runs are cancelled first.'
        );
        yield* Effect.async<void>((resume) => {
          const stop = () => resume(Effect.void);
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
          return Effect.sync(() => {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
          });
        });
      }),
    (server) =>
      Effect.tryPromise({
        try: () => server.close(),
        catch: (cause) =>
          new ObserverCommandError({
            detail: 'Observer Window server failed to stop cleanly',
            cause,
          }),
      }).pipe(Effect.orDie)
  )
);

Exit.match(serverExit, {
  onFailure: (cause) => {
    console.error(Cause.pretty(cause));
    process.exitCode = 1;
  },
  onSuccess: () => {
    process.exitCode = 0;
  },
});
