import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { Effect } from 'effect';

mock.module('@/electron/lib/online.js', () => ({
  getEffectiveOnlineState: () => ({ effectiveOnline: true, reason: 'online' }),
}));
mock.module('@/electron/updater.js', () => ({
  checkIfInstallerUpdateAvailable: async () => ({
    success: true,
    updated: false,
  }),
}));
mock.module('@/electron/startup.js', () => ({
  downloadLatestUmu: async () => ({ success: true, updated: false }),
}));

let SystemUpdateManager: typeof import('../src/electron/system-updater.js').SystemUpdateManager;
let requiresSystemUpdateShutdown: typeof import('../src/electron/system-updater.js').requiresSystemUpdateShutdown;

beforeAll(async () => {
  ({ SystemUpdateManager, requiresSystemUpdateShutdown } = await import(
    '../src/electron/system-updater.js'
  ));
});

describe('SystemUpdateManager', () => {
  test('stops running system updaters when one requires app shutdown', async () => {
    const calls: string[] = [];
    const manager = new SystemUpdateManager([
      {
        id: 'installer',
        label: 'installer',
        shouldRun: () => Effect.succeed(true),
        update: () =>
          Effect.sync(() => {
            calls.push('installer');
            return {
              id: 'installer',
              success: true,
              updated: true,
              shutdownRequired: true,
            };
          }),
      },
      {
        id: 'background-tool',
        label: 'background tool',
        shouldRun: () => Effect.succeed(true),
        update: () =>
          Effect.sync(() => {
            calls.push('background-tool');
            return { id: 'background-tool', success: true, updated: true };
          }),
      },
    ]);

    const results = await Effect.runPromise(
      manager.updateOnlineSystem({
        onStatus: () => undefined,
        onProgress: () => undefined,
      })
    );

    expect(calls).toEqual(['installer']);
    expect(results).toHaveLength(1);
  });

  test('only shuts down for updates that explicitly require it', () => {
    expect(
      requiresSystemUpdateShutdown([
        { id: 'umu-launcher', success: true, updated: true },
      ])
    ).toBe(false);
    expect(
      requiresSystemUpdateShutdown([
        {
          id: 'installer',
          success: true,
          updated: true,
          shutdownRequired: true,
        },
      ])
    ).toBe(true);
  });
});
