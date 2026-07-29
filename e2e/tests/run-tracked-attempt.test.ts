import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';
import { runTrackedAttempt } from '../src/run-tracked-attempt';

const runAttempt = (script: string, cancellation?: Effect.Effect<void>) =>
  Effect.runPromise(
    runTrackedAttempt({
      launch: {
        command: process.execPath,
        args: ['-e', script],
        options: {
          detached: process.platform === 'linux',
          stdio: 'ignore',
        },
      },
      cancellation,
      completionTimeout: '5 seconds',
      completionCondition: 'test process completion',
      windowsJobResultPath: 'unused-on-posix.json',
    })
  );

describe('tracked attempt lifecycle', () => {
  test('returns a successful process result after inspection and cleanup', async () => {
    if (process.platform === 'win32') return;

    const result = await runAttempt('process.exit(0)');

    expect(result.completion.kind).toBe('process');
    if (result.completion.kind === 'process') {
      expect(Exit.isSuccess(result.completion.processExit)).toBe(true);
    }
    expect(Exit.isSuccess(result.inspectionExit)).toBe(true);
    expect(Exit.isSuccess(result.cleanupExit)).toBe(true);
    expect(result.unexpectedSurvivors).toEqual([]);
  });

  test('keeps a non-zero process exit as a classified attempt result', async () => {
    if (process.platform === 'win32') return;

    const result = await runAttempt('process.exit(7)');

    expect(result.completion.kind).toBe('process');
    if (result.completion.kind === 'process') {
      expect(Exit.isFailure(result.completion.processExit)).toBe(true);
    }
    expect(Exit.isSuccess(result.cleanupExit)).toBe(true);
  });

  test('cancellation still runs tracked process cleanup', async () => {
    if (process.platform === 'win32') return;

    const result = await runAttempt(
      'setInterval(() => {}, 1000)',
      Effect.sleep('25 millis')
    );

    expect(result.completion.kind).toBe('cancelled');
    expect(Exit.isSuccess(result.cleanupExit)).toBe(true);
    expect(() => process.kill(result.child.pid!, 0)).toThrow();
  });
});
