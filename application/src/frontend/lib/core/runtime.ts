import { Effect } from 'effect';

export function runDetached<E>(
  effect: Effect.Effect<void, E>,
  label: string
): void {
  void Effect.runPromise(
    effect.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => console.error(`${label}:`, error))
      ),
      Effect.ignore
    )
  );
}
