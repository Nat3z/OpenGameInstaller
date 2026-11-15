import { type Duration, Effect, Stream, SubscriptionRef } from 'effect';

/** Addon questions (`input-asked`) waiting on a person right now. */
const open = Effect.runSync(SubscriptionRef.make(0));

/** Counts `effect` as an open question for as long as it runs. */
export const whileAsking = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    SubscriptionRef.update(open, (n) => n + 1),
    () => effect,
    () => SubscriptionRef.update(open, (n) => n - 1)
  );

const until = (done: (n: number) => boolean) =>
  open.changes.pipe(Stream.filter(done), Stream.runHead);

/**
 * Fails after `duration` of the addon's own time. The clock stops while any
 * addon question is open (a person may take minutes) and starts over after.
 */
export const addonDeadline = <E>(
  duration: Duration.DurationInput,
  onTimeout: () => E
): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    while (true) {
      yield* until((n) => n === 0);
      const asked = yield* Effect.raceFirst(
        Effect.sleep(duration).pipe(Effect.as(false)),
        until((n) => n > 0).pipe(Effect.as(true))
      );
      if (!asked) return yield* Effect.fail(onTimeout());
    }
  });
