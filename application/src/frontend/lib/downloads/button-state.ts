import { Effect } from 'effect';

export const resetButtonOnExit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  reset: () => void
): Effect.Effect<A, E, R> => effect.pipe(Effect.ensuring(Effect.sync(reset)));
