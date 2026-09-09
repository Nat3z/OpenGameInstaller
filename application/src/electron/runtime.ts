import { formatErrorResponse } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Fiber, ManagedRuntime } from 'effect';
import {
  type AppServices,
  AppServicesLive,
} from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

// One runtime for the whole main process. Its layer is memoised, so the
// services are built once; the Database service resolves the connection on
// each call, which keeps startup (backup restore, migrations) free to run
// before the database file is touched.
const makeWarmRuntime = (): ManagedRuntime.ManagedRuntime<
  AppServices,
  never
> => {
  const runtime = ManagedRuntime.make(AppServicesLive);
  runtime.runSync(Effect.void);
  return runtime;
};

const electronRuntime = makeWarmRuntime();
const backgroundFibers = new Set<Fiber.RuntimeFiber<unknown, unknown>>();

export class EffectBoundaryError {
  readonly status = 'error' as const;

  constructor(readonly error: string) {}
}

/** An effect that may depend on any application service. */
export type AppEffect<A, E = never> = Effect.Effect<A, E, AppServices>;

export const runElectronEffect = <A, E>(
  effect: Effect.Effect<A, E, AppServices>
): Promise<A> => electronRuntime.runPromise(logger.observe(effect));

export const forkElectronEffect = <A, E>(
  effect: Effect.Effect<A, E, AppServices>
): void => {
  const fiber = electronRuntime.runFork(logger.observe(effect));
  const trackedFiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
  backgroundFibers.add(trackedFiber);
  fiber.addObserver(() => backgroundFibers.delete(trackedFiber));
};

export const runElectronSync = <A, E>(
  effect: Effect.Effect<A, E, AppServices>
): A => electronRuntime.runSync(logger.observe(effect));

const formatBoundaryError = (error: unknown): EffectBoundaryError =>
  new EffectBoundaryError(formatErrorResponse(error).error);

export const runEffectBoundary = <A, E>(
  effect: Effect.Effect<A, E, AppServices>
): Promise<EffectBoundaryError | A> =>
  runElectronEffect(
    effect.pipe(
      Effect.catchAll((error) => Effect.succeed(formatBoundaryError(error)))
    )
  );

export const runSyncBoundary = <A, E>(
  effect: Effect.Effect<A, E, AppServices>
): EffectBoundaryError | A =>
  electronRuntime.runSync(
    logger.observe(
      effect.pipe(
        Effect.catchAll((error) => Effect.succeed(formatBoundaryError(error)))
      )
    )
  );

/**
 * Adapts an Effect-returning handler to the RPC router while running it on the
 * application runtime, so handlers may use `Database`, `Settings`, `Library`.
 * Replaces `ipcBoundary` from `@ogi-sdk/errors`, which runs outside the runtime.
 */
export const ipcServiceBoundary =
  <Args extends readonly unknown[], A, E>(
    operation: (...args: Args) => Effect.Effect<A, E, AppServices>
  ) =>
  (...args: Args): Promise<A | EffectBoundaryError> =>
    runEffectBoundary(Effect.suspend(() => operation(...args)));

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
