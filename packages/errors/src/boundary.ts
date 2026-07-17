import { Effect } from 'effect';
import { formatErrorResponse } from './index.js';

export const runEffectBoundary = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<{ status: 'error'; error: string } | A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.catchAll((error) => Effect.succeed(formatErrorResponse(error)))
    )
  );

export const runSyncBoundary = <A, E>(
  effect: Effect.Effect<A, E>
): { status: 'error'; error: string } | A =>
  Effect.runSync(
    effect.pipe(
      Effect.catchAll((error) => Effect.succeed(formatErrorResponse(error)))
    )
  );

/**
 * Shared IPC handler boundary. Wraps an Effect, async operation, or sync
 * operation into an ipcMain.handle-compatible handler that catches all errors
 * and formats them as `{ status: 'error', error: string }`.
 *
 * @example
 * ```ts
 * ipcMain.handle('my-channel', ipcBoundary((_, arg) => doWork(arg)));
 * ```
 */
export const ipcBoundary =
  <Args extends readonly unknown[], A, E = never>(
    operation: (...args: Args) => Effect.Effect<A, E> | Promise<A> | A
  ) =>
  (...args: Args): Promise<{ status: 'error'; error: string } | A> =>
    Effect.runPromise(
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
        ),
        Effect.catchAll((error) =>
          Effect.succeed(formatErrorResponse(error))
        )
      )
    );
