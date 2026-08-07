import { describe, expect, test } from 'bun:test';
import { SteamProcessError, SteamVdfWriteError } from '@ogi-sdk/errors';
import { Deferred, Effect, Fiber, Logger } from 'effect';
import {
  getSteamCommandCandidates,
  runWithSteamLifecycle,
} from '../src/electron/lib/steam-process.js';

const record = (calls: string[], name: string): Effect.Effect<void> =>
  Effect.sync(() => {
    calls.push(name);
  });

describe('Steam lifecycle workflow', () => {
  test('falls back to the Flatpak Steam command', () => {
    expect(getSteamCommandCandidates(['-shutdown'])).toEqual([
      { command: 'steam', args: ['-shutdown'] },
      {
        command: 'flatpak',
        args: ['run', 'com.valvesoftware.Steam', '-shutdown'],
      },
    ]);
  });

  test('routes launch URLs through the selected Steam installation', () => {
    const url = 'steam://rungameid/123';
    expect(getSteamCommandCandidates([url], 'native')).toEqual([
      { command: 'steam', args: [url] },
    ]);
    expect(getSteamCommandCandidates([url], 'flatpak')).toEqual([
      {
        command: 'flatpak',
        args: ['run', 'com.valvesoftware.Steam', url],
      },
    ]);
  });

  test('runs the mutation directly when Steam is already closed', async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      runWithSteamLifecycle({
        allowSteamShutdown: false,
        status: Effect.sync(() => {
          calls.push('status');
          return false;
        }),
        shutdownAndWait: record(calls, 'shutdown'),
        startAndWait: record(calls, 'start'),
        operation: Effect.sync(() => {
          calls.push('operation');
          return 42;
        }),
      })
    );

    expect(result).toEqual({ value: 42, restartWarning: undefined });
    expect(calls).toEqual(['status', 'operation']);
  });

  test('requires authorization before stopping Steam', async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      Effect.either(
        runWithSteamLifecycle({
          allowSteamShutdown: false,
          status: Effect.succeed(true),
          shutdownAndWait: record(calls, 'shutdown'),
          startAndWait: record(calls, 'start'),
          operation: record(calls, 'operation'),
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left')
      expect(result.left._tag).toBe('SteamRunningError');
    expect(calls).toEqual([]);
  });

  test('stops Steam, commits the mutation, and restarts in order', async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      runWithSteamLifecycle({
        allowSteamShutdown: true,
        status: Effect.succeed(true),
        shutdownAndWait: record(calls, 'shutdown'),
        startAndWait: record(calls, 'start'),
        operation: Effect.sync(() => {
          calls.push('operation');
          return 42;
        }),
      })
    );

    expect(result.value).toBe(42);
    expect(result.restartWarning).toBeUndefined();
    expect(calls).toEqual(['shutdown', 'operation', 'start']);
  });

  test('attempts to restart Steam when the mutation fails', async () => {
    const calls: string[] = [];
    const writeError = new SteamVdfWriteError({
      message: 'write failed',
      path: '/tmp/shortcuts.vdf',
    });
    const result = await Effect.runPromise(
      Effect.either(
        runWithSteamLifecycle({
          allowSteamShutdown: true,
          status: Effect.succeed(true),
          shutdownAndWait: record(calls, 'shutdown'),
          startAndWait: record(calls, 'start'),
          operation: record(calls, 'operation').pipe(
            Effect.flatMap(() => Effect.fail(writeError))
          ),
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left).toBe(writeError);
    expect(calls).toEqual(['shutdown', 'operation', 'start']);
  });

  test('attempts to restart Steam when shutdown fails', async () => {
    const calls: string[] = [];
    const shutdownError = new SteamProcessError({
      message: 'shutdown failed',
      operation: 'shutdown',
    });
    const result = await Effect.runPromise(
      Effect.either(
        runWithSteamLifecycle({
          allowSteamShutdown: true,
          status: Effect.succeed(true),
          shutdownAndWait: record(calls, 'shutdown').pipe(
            Effect.andThen(Effect.fail(shutdownError))
          ),
          startAndWait: record(calls, 'start'),
          operation: record(calls, 'operation'),
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left).toBe(shutdownError);
    expect(calls).toEqual(['shutdown', 'start']);
  });

  test('restarts Steam before propagating an interrupted mutation', async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const shutdownComplete = yield* Deferred.make<void>();
        const fiber = yield* Effect.fork(
          runWithSteamLifecycle({
            allowSteamShutdown: true,
            status: Effect.succeed(true),
            shutdownAndWait: record(calls, 'shutdown').pipe(
              Effect.andThen(Deferred.succeed(shutdownComplete, undefined)),
              Effect.asVoid
            ),
            startAndWait: record(calls, 'start'),
            operation: record(calls, 'operation').pipe(
              Effect.andThen(Effect.never)
            ),
          })
        );

        yield* Deferred.await(shutdownComplete);
        return yield* Fiber.interrupt(fiber);
      })
    );

    expect(result._tag).toBe('Failure');
    expect(calls).toEqual(['shutdown', 'operation', 'start']);
  });

  test('logs a restart failure without replacing the mutation error', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const writeError = new SteamVdfWriteError({
      message: 'write failed',
      path: '/tmp/shortcuts.vdf',
    });
    const restartError = new SteamProcessError({
      message: 'start failed',
      operation: 'start',
    });
    const logger = Logger.make<unknown, void>(({ message }) => {
      logs.push(String(message));
    });
    const result = await Effect.runPromise(
      Effect.either(
        runWithSteamLifecycle({
          allowSteamShutdown: true,
          status: Effect.succeed(true),
          shutdownAndWait: record(calls, 'shutdown'),
          startAndWait: record(calls, 'start').pipe(
            Effect.andThen(Effect.fail(restartError))
          ),
          operation: record(calls, 'operation').pipe(
            Effect.andThen(Effect.fail(writeError))
          ),
        })
      ).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger)))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left).toBe(writeError);
    expect(calls).toEqual(['shutdown', 'operation', 'start']);
    expect(logs.some((message) => message.includes('start failed'))).toBe(true);
  });

  test('returns a warning when restart fails after a committed mutation', async () => {
    const calls: string[] = [];
    const restartError = new SteamProcessError({
      message: 'start failed',
      operation: 'start',
    });
    const result = await Effect.runPromise(
      runWithSteamLifecycle({
        allowSteamShutdown: true,
        status: Effect.succeed(true),
        shutdownAndWait: record(calls, 'shutdown'),
        startAndWait: record(calls, 'start').pipe(
          Effect.flatMap(() => Effect.fail(restartError))
        ),
        operation: Effect.sync(() => {
          calls.push('operation');
          return 42;
        }),
      })
    );

    expect(result.value).toBe(42);
    expect(result.restartWarning).toContain('start failed');
    expect(calls).toEqual(['shutdown', 'operation', 'start']);
  });
});
