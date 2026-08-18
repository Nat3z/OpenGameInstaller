import { expect, mock, test } from 'bun:test';
import { Effect } from 'effect';

mock.module('@/frontend/lib/config/client', () => ({
  getConfigClientOption: () => null,
  fetchAddonsWithConfigure: () => Effect.succeed([]),
}));

mock.module('@ogi-sdk/client-kit', () => ({
  Connection: {
    make: () => new Promise(() => {}),
  },
}));

test('frontend IPC initializes while the addon server is unavailable', async () => {
  const result = await Promise.race([
    import('../src/frontend/lib/core/ipc.js').then(() => 'initialized'),
    new Promise<'timed-out'>((resolve) =>
      setTimeout(() => resolve('timed-out'), 100)
    ),
  ]);

  expect(result).toBe('initialized');
});
