import { formatErrorResponse } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Fiber, Layer, ManagedRuntime } from 'effect';

const logger = createLogger(LOGGER_PREFIXES.electron);
const electronRuntime = ManagedRuntime.make(Layer.empty);
const backgroundFibers = new Set<Fiber.RuntimeFiber<unknown, unknown>>();

export class EffectBoundaryError {
  readonly status = 'error' as const;

  constructor(readonly error: string) {}
}

export const runElectronEffect = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => electronRuntime.runPromise(logger.observe(effect));

export const forkElectronEffect = <A, E>(effect: Effect.Effect<A, E>): void => {
  const fiber = electronRuntime.runFork(logger.observe(effect));
  const trackedFiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
  backgroundFibers.add(trackedFiber);
  fiber.addObserver(() => backgroundFibers.delete(trackedFiber));
};

export const runElectronSync = <A, E>(effect: Effect.Effect<A, E>): A =>
  electronRuntime.runSync(logger.observe(effect));

const formatBoundaryError = (error: unknown): EffectBoundaryError =>
  new EffectBoundaryError(formatErrorResponse(error).error);

export const runEffectBoundary = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<EffectBoundaryError | A> =>
  runElectronEffect(
    effect.pipe(
      Effect.catchAll((error) => Effect.succeed(formatBoundaryError(error)))
    )
  );

export const runSyncBoundary = <A, E>(
  effect: Effect.Effect<A, E>
): EffectBoundaryError | A =>
  electronRuntime.runSync(
    logger.observe(
      effect.pipe(
        Effect.catchAll((error) => Effect.succeed(formatBoundaryError(error)))
      )
    )
  );

export const disposeElectronRuntime = async (): Promise<void> => {
  try {
    await Promise.allSettled(
      Array.from(backgroundFibers, (fiber) =>
        electronRuntime.runPromise(
          logger.observe(
            Fiber.interrupt(fiber).pipe(
              Effect.timeout('5 seconds'),
              Effect.ignore
            )
          )
        )
      )
    );
  } finally {
    await electronRuntime.dispose();
  }
};
