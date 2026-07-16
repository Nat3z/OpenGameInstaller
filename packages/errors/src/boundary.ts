import { Effect } from 'effect';
import { formatErrorResponse } from './index.js';

export const runEffectBoundary = <A, E>(effect: Effect.Effect<A, E>): Promise<{ status: 'error'; error: string } | A> =>
  Effect.runPromise(effect.pipe(
    Effect.catchAll((error) => Effect.succeed(formatErrorResponse(error)))
  ));

export const runSyncBoundary = <A, E>(effect: Effect.Effect<A, E>): { status: 'error'; error: string } | A =>
  Effect.runSync(effect.pipe(
    Effect.catchAll((error) => Effect.succeed(formatErrorResponse(error)))
  ));
