import { formatErrorResponse } from '@ogi/errors';
import { Effect, Layer, ManagedRuntime } from 'effect';

const electronRuntime = ManagedRuntime.make(Layer.empty);

export const runElectronEffect = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => electronRuntime.runPromise(effect);

export const forkElectronEffect = <A, E>(effect: Effect.Effect<A, E>): void => {
  electronRuntime.runFork(effect);
};

export const runElectronSync = <A, E>(effect: Effect.Effect<A, E>): A =>
  electronRuntime.runSync(effect);

export const runEffectBoundary = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<{ status: 'error'; error: string } | A> =>
  runElectronEffect(
    effect.pipe(
      Effect.catchAll((error) => Effect.succeed(formatErrorResponse(error)))
    )
  );

export const runSyncBoundary = <A, E>(
  effect: Effect.Effect<A, E>
): { status: 'error'; error: string } | A =>
  electronRuntime.runSync(
    effect.pipe(
      Effect.catchAll((error) => Effect.succeed(formatErrorResponse(error)))
    )
  );

export const disposeElectronRuntime = (): Promise<void> =>
  electronRuntime.dispose();
