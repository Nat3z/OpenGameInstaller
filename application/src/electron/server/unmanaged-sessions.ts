import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Deferred, type Duration, Effect, Stream } from 'effect';
import { startAddons } from '@/electron/handlers/handler.addon.js';
import { waitForAddonManifests } from '@/electron/manager/manager.addon-readiness.js';
import { runLaunchAppHooks } from '@/electron/server/addon-lifecycle.js';
import { Library, Settings } from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/** Sessions whose game has exited and whose post hooks are still running. */
const ending = new Set<Deferred.Deferred<void>>();

export type UnmanagedSession = {
  /** For a start that failed: frees the game without running hooks. */
  readonly cancel: Effect.Effect<void>;
  /** Settles once the session is over: post hooks done, game freed. */
  readonly ended: Effect.Effect<void>;
};

/**
 * Ends an unmanaged (desktop) session in the main process, whatever happens
 * to the window: on the game's exit, run its post hooks once, then free its
 * reservation. Subscribes before returning, so call it before the game
 * starts, and run `cancel` if the start fails.
 */
export const finishOnExit = (
  appID: number,
  token: string
): Effect.Effect<UnmanagedSession, never, Library | Settings> =>
  Effect.gen(function* () {
    const library = yield* Library;
    const settings = yield* Settings;
    const subscribed = yield* Deferred.make<void>();
    const stop = yield* Deferred.make<boolean>();
    const ended = yield* Deferred.make<void>();

    const postHooks = Effect.gen(function* () {
      const game = yield* library.get(appID);
      if (!game) return;
      // An addon that crashed while the game ran comes back first (the server
      // replays its config), so its save backup still runs.
      yield* startAddons().pipe(
        Effect.provideService(Settings, settings),
        Effect.catchAll((error) =>
          logger.warn('[launch] could not restart addons', error)
        )
      );
      yield* waitForAddonManifests();
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
      ending.add(ended);
      yield* postHooks;
    }).pipe(
      Effect.scoped,
      Effect.catchAllCause((cause) =>
        logger.error(`[launch] ending session ${appID} failed`, cause)
      ),
      // Only this session's token: never a newer launch's hold.
      Effect.ensuring(library.unreserve(appID, token)),
      Effect.ensuring(
        Effect.suspend(() => {
          ending.delete(ended);
          return Deferred.succeed(ended, undefined);
        })
      )
    );

    yield* Effect.forkDaemon(session);
    yield* Deferred.await(subscribed);
    return {
      cancel: Deferred.succeed(stop, false).pipe(Effect.asVoid),
      ended: Deferred.await(ended),
    };
  });

/** For a quit: lets running post hooks (a save backup) finish, bounded. */
export const awaitEndingSessions = (
  timeout: Duration.DurationInput
): Effect.Effect<void> =>
  Effect.forEach([...ending], Deferred.await, { discard: true }).pipe(
    Effect.timeout(timeout),
    Effect.ignore
  );
