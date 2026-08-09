import { Effect } from 'effect';

let resolveRecovery: (() => void) | undefined;
let recoveryFailure: unknown;
const recovery = new Promise<void>((resolve) => {
  resolveRecovery = resolve;
});
let started = false;

export function startUpdateRecovery<E>(effect: Effect.Effect<void, E>): void {
  if (started) return;
  started = true;
  Effect.runPromise(effect)
    .catch((cause) => {
      recoveryFailure = cause;
    })
    .finally(() => resolveRecovery?.());
}

export function afterUpdateRecovery<A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return Effect.promise(() => recovery).pipe(
    Effect.zipRight(
      Effect.suspend(() =>
        recoveryFailure === undefined
          ? effect
          : Effect.die(
              new Error('Update recovery failed', { cause: recoveryFailure })
            )
      )
    )
  );
}
