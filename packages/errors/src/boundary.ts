import { Effect } from 'effect';
import { formatErrorResponse } from './index.js';

export type ErrorResponse = {
  readonly status: 'error';
  readonly error: string;
};

/** Keeps error formatting inside Effect until the application boundary. */
export const effectBoundary = <A, E>(
  effect: Effect.Effect<A, E>
): Effect.Effect<A | ErrorResponse> =>
  effect.pipe(
    Effect.catchAll((error) => Effect.succeed(formatErrorResponse(error)))
  );

/** Explicit Promise adapter for legacy callers and framework callbacks. */
export const runEffectBoundaryPromise = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A | ErrorResponse> => Effect.runPromise(effectBoundary(effect));

/** @deprecated Use effectBoundary or runEffectBoundaryPromise. */
export const runEffectBoundary = runEffectBoundaryPromise;

export const runSyncBoundary = <A, E>(
  effect: Effect.Effect<A, E>
): A | ErrorResponse => Effect.runSync(effectBoundary(effect));

/** Adapts an Effect-returning operation to an ipcMain.handle callback. */
export const ipcEffectBoundary =
  <Args extends readonly unknown[], A, E>(
    operation: (...args: Args) => Effect.Effect<A, E>
  ) =>
  (...args: Args): Promise<A | ErrorResponse> =>
    runEffectBoundaryPromise(
      Effect.try({
        try: () => operation(...args),
        catch: (cause) => cause,
      }).pipe(Effect.flatten)
    );

/**
 * Legacy IPC adapter for Promise and synchronous operations. New handlers should
 * return Effect and use ipcEffectBoundary so failures stay in the error channel.
 */
export const ipcBoundary =
  <Args extends readonly unknown[], A, E = never>(
    operation: (...args: Args) => Effect.Effect<A, E> | Promise<A> | A
  ) =>
  (...args: Args): Promise<A | ErrorResponse> =>
    runEffectBoundaryPromise(
      Effect.try({
        try: () => operation(...args),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((result) =>
          Effect.isEffect(result)
            ? result
            : Effect.tryPromise({
                try: () => Promise.resolve(result),
                catch: (cause) => cause,
              })
        )
      )
    );
