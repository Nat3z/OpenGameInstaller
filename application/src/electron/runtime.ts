import { formatErrorResponse } from '@ogi/errors';
import { Effect, Fiber, Layer, ManagedRuntime } from 'effect';

const electronRuntime = ManagedRuntime.make(Layer.empty);
const backgroundFibers = new Set<Fiber.RuntimeFiber<unknown, unknown>>();

export const runElectronEffect = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => electronRuntime.runPromise(effect);

export const forkElectronEffect = <A, E>(effect: Effect.Effect<A, E>): void => {
  const fiber = electronRuntime.runFork(effect);
  const trackedFiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
  backgroundFibers.add(trackedFiber);
  fiber.addObserver(() => backgroundFibers.delete(trackedFiber));
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

export const disposeElectronRuntime = async (): Promise<void> => {
  try {
    await Promise.allSettled(
      Array.from(backgroundFibers, (fiber) =>
        electronRuntime.runPromise(
          Fiber.interrupt(fiber).pipe(
            Effect.timeout('5 seconds'),
            Effect.ignore
          )
        )
      )
    );
  } finally {
    await electronRuntime.dispose();
  }
};
