import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Deferred, type Duration, Effect, Stream } from 'effect';
import { startAddons } from '@/electron/handlers/handler.addon.js';
import { waitForAddonManifests } from '@/electron/manager/manager.addon-readiness.js';
import { runLaunchAppHooks } from '@/electron/server/addon-lifecycle.js';
import { Library, Settings } from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/** Sessions whose game has exited and whose post hooks are still running. */
const ending = new Set<Deferred.Deferred<void>>();

/** Counts `effect` as an ending session, so a quit waits for it. */
const tracked = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.tap(Deferred.make<void>(), (done) =>
      Effect.sync(() => ending.add(done))
    ),
    () => effect,
    (done) =>
      Effect.sync(() => ending.delete(done)).pipe(
        Effect.zipRight(Deferred.succeed(done, undefined))
      )
  );

/**
 * A desktop session's post hooks, from the main process. An addon that
 * crashed while the game ran comes back first (the server replays its
 * config), so its save backup still runs.
 */
const runPostHooks = (
  appID: number
): Effect.Effect<void, never, Library | Settings> =>
  Effect.gen(function* () {
    const game = yield* (yield* Library).get(appID);
    if (!game) return;
    yield* startAddons().pipe(
      Effect.catchAll((error) =>
        logger.warn('[launch] could not restart addons', error)
      )
    );
    yield* waitForAddonManifests();
    const result = yield* runLaunchAppHooks(game, 'post');
    if (!result.success)
      yield* logger.warn(`[launch] post hooks failed for ${appID}`);
  }).pipe(
    Effect.catchAllCause((cause) =>
      logger.error(`[launch] post hooks for ${appID} failed`, cause)
    )
  );

/**
 * Desktop holds taken by the window (`reserveGame`) and not yet handed to a
 * session (`launchGame`) or released. If the window goes away mid-flow (a
 * closed macOS window, a reload) nobody else knows the token, so main frees
 * them. A hold whose wrapped game is still running (`busy`) is freed only
 * once that game exits.
 */
const windowHolds = new Map<
  string,
  { readonly appID: number; busy: boolean; abandoned: boolean }
>();

export const holdForWindow = (appID: number, token: string): void =>
  void windowHolds.set(token, { appID, busy: false, abandoned: false });

/** The window handed the hold to a session, or released it itself. */
export const dropWindowHold = (token: string): void =>
  void windowHolds.delete(token);

const free = (token: string) =>
  Effect.flatMap(Library, (library) => {
    const hold = windowHolds.get(token);
    windowHolds.delete(token);
    return hold ? library.unreserve(hold.appID, token) : Effect.void;
  });

/** The window that held these is gone: free every hold not in use. */
export const releaseWindowHolds: Effect.Effect<void, never, Library> =
  // Suspended: the holds are read when the window goes, not at import.
  Effect.suspend(() =>
    Effect.forEach(
      [...windowHolds],
      ([token, hold]) =>
        hold.busy
          ? Effect.sync(() => {
              hold.abandoned = true;
            })
          : free(token),
      { discard: true }
    )
  );

/**
 * Runs a wrapped game under the window's hold. If the window went away while
 * it ran, nobody is left to run its post hooks or release, so main does both.
 */
export const whileWrapped = <A, E, R>(
  token: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | Library | Settings> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const hold = windowHolds.get(token);
      if (hold) hold.busy = true;
    }),
    () => effect,
    () =>
      Effect.suspend(() => {
        const hold = windowHolds.get(token);
        if (!hold) return Effect.void;
        hold.busy = false;
        return hold.abandoned
          ? tracked(runPostHooks(hold.appID).pipe(Effect.ensuring(free(token))))
          : Effect.void;
      })
  );

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
    const postHooks = runPostHooks(appID).pipe(
      Effect.provideService(Library, library),
      Effect.provideService(Settings, settings)
    );

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
