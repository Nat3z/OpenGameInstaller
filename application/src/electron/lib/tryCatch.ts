import { Effect } from 'effect';

/** @deprecated Prefer Effect.try / Effect.tryPromise directly. */
export const tryCatch = <A>(operation: () => A): Effect.Effect<Awaited<A>, unknown> => {
  const result = Effect.try({ try: operation, catch: (cause) => cause });
  return result.pipe(
    Effect.flatMap((value) =>
      value instanceof Promise
        ? Effect.tryPromise({ try: () => value, catch: (cause) => cause })
        : Effect.succeed(value as Awaited<A>)
    )
  );
};
