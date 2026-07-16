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
 * Shared IPC handler boundary. Wraps an async or sync operation into an
 * ipcMain.handle-compatible handler that catches all errors and formats
 * them as `{ status: 'error', error: string }`.
 *
 * @example
 * ```ts
 * ipcMain.handle('my-channel', ipcBoundary(async (_, arg) => doWork(arg)));
 * ```
 */
export const ipcBoundary =
  <Args extends readonly unknown[], A>(
    operation: (...args: Args) => Promise<A> | A
  ) =>
  (...args: Args): Promise<{ status: 'error'; error: string } | A> =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () => Promise.resolve(operation(...args)),
        catch: (cause) => formatErrorResponse(cause),
      }).pipe(Effect.catchAll((error) => Effect.succeed(error)))
    );
