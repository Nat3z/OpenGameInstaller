import { type Duration, Effect, Stream, SubscriptionRef } from 'effect';

/**
 * How long each addon call may wait for its reply; searches can scrape
 * slowly. Time a person spends answering the addon's question doesn't count.
 */
export const REPLY_TIMEOUT = {
  search: '60 seconds',
  'game-details': '30 seconds',
  catalog: '30 seconds',
} as const;

/** Per addon: its questions (`input-asked`) waiting on a person right now. */
const open = Effect.runSync(
  SubscriptionRef.make<ReadonlyMap<string, number>>(new Map())
);

const bump = (addonId: string, by: number) =>
  SubscriptionRef.update(open, (counts) => {
    const next = new Map(counts);
    const count = (next.get(addonId) ?? 0) + by;
    if (count > 0) next.set(addonId, count);
    else next.delete(addonId);
    return next;
  });

/**
 * Counts `effect` as one of `addonId`'s open questions while it runs. A
 * question from an unknown addon pauses no one's deadline.
 */
export const whileAsking =
  (addonId: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    addonId
      ? Effect.acquireUseRelease(
          bump(addonId, 1),
          () => effect,
          () => bump(addonId, -1)
        )
      : effect;

const until = (addonId: string, asking: boolean) =>
  open.changes.pipe(
    Stream.filter((counts) => counts.has(addonId) === asking),
    Stream.runHead
  );

/**
 * Fails after `duration` of `addonId`'s own time. Its clock stops while that
 * addon has a question open (a person may take minutes) and starts over
 * after; other addons' questions don't affect it.
 */
export const addonDeadline = <E>(
  addonId: string,
  duration: Duration.DurationInput,
  onTimeout: () => E
): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    while (true) {
      yield* until(addonId, false);
      const asked = yield* Effect.raceFirst(
        Effect.sleep(duration).pipe(Effect.as(false)),
        until(addonId, true).pipe(Effect.as(true))
      );
      if (!asked) return yield* Effect.fail(onTimeout());
    }
  });
