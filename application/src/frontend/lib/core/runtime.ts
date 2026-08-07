import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Fiber } from 'effect';

const logger = createLogger(LOGGER_PREFIXES.frontend);

export const runFrontendEffect = <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => Effect.runPromise(logger.observe(effect));

export const forkFrontendEffect = <A, E>(
  effect: Effect.Effect<A, E>
): Fiber.RuntimeFiber<A, E> => Effect.runFork(logger.observe(effect));

export const runFrontendSync = <A, E>(effect: Effect.Effect<A, E>): A =>
  Effect.runSync(logger.observe(effect));

export function runDetached<E>(
  effect: Effect.Effect<void, E>,
  label: string
): void {
  void runFrontendEffect(
    effect.pipe(
      Effect.tapError((error) => logger.error(`${label}:`, error)),
      Effect.ignore
    )
  );
}
