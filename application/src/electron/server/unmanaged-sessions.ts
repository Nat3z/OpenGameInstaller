import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Deferred, type Duration, Effect, Stream } from 'effect';
import { runLaunchAppHooks } from '@/electron/server/addon-lifecycle.js';
import { Library } from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/** Sessions whose game has exited and whose post hooks are still running. */
const ending = new Set<Deferred.Deferred<void>>();

/**
 * Ends an unmanaged (desktop) session in the main process, whatever happens
 * to the window: on the game's exit, run its post hooks once, then free its
 * reservation. Subscribes before returning, so call it before the game
 * starts, and run `cancel` if the start fails.
 */
export const finishOnExit = (
  appID: number,
  token: string
): Effect.Effect<{ readonly cancel: Effect.Effect<void> }, never, Library> =>
  Effect.gen(function* () {
    const library = yield* Library;
    const subscribed = yield* Deferred.make<void>();
    const stop = yield* Deferred.make<boolean>();

    const postHooks = Effect.gen(function* () {
      const game = yield* library.get(appID);
      if (!game) return;
      const result = yield* runLaunchAppHooks(game, 'post');
      if (!result.success)
        yield* logger.warn(`[launch] post hooks failed for ${appID}`);
    });

    const session = Effect.gen(function* () {
      const changes = yield* library.changes;
      yield* Deferred.succeed(subscribed, undefined);
      const exited = yield* changes.pipe(
        Stream.filter(
          (change) => change._tag === 'Exited' && change.appID === appID
        ),
        Stream.runHead,
        Effect.map(() => true),
        Effect.raceFirst(Deferred.await(stop))
      );
      if (!exited) return;
      const done = yield* Deferred.make<void>();
      ending.add(done);
      yield* postHooks.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            ending.delete(done);
            return Deferred.succeed(done, undefined);
          })
        )
      );
    }).pipe(
      Effect.scoped,
      Effect.catchAllCause((cause) =>
        logger.error(`[launch] ending session ${appID} failed`, cause)
      ),
      // Only this session's token: never a newer launch's hold.
      Effect.ensuring(library.unreserve(appID, token))
    );

    yield* Effect.forkDaemon(session);
    yield* Deferred.await(subscribed);
    return { cancel: Deferred.succeed(stop, false).pipe(Effect.asVoid) };
  });

/** For a quit: lets running post hooks (a save backup) finish, bounded. */
export const awaitEndingSessions = (
  timeout: Duration.DurationInput
): Effect.Effect<void> =>
  Effect.forEach([...ending], Deferred.await, { discard: true }).pipe(
    Effect.timeout(timeout),
    Effect.ignore
  );
