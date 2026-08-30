import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { Effect } from 'effect';

let configUpdateCalls = 0;
let configured = false;
let markConfigUpdateStarted: () => void;
let releaseConfigUpdate: () => void;

const configUpdateStarted = new Promise<void>((resolve) => {
  markConfigUpdateStarted = resolve;
});
const configUpdateGate = new Promise<void>((resolve) => {
  releaseConfigUpdate = resolve;
});

mock.module('@/frontend/lib/core/ipc', () => ({
  queryConnectedAddons: () =>
    Effect.succeed([
      {
        id: 'configured-addon',
        configTemplate: {},
        eventsAvailable: configured ? ['launch-app'] : [],
      },
    ]),
  getAddonServer: () =>
    Effect.succeed({
      addon: () => ({
        configUpdate: async () => {
          configUpdateCalls++;
          markConfigUpdateStarted();
          await configUpdateGate;
          configured = true;
        },
      }),
    }),
}));

let fetchAddonsWithConfigure: typeof import('../src/frontend/lib/config/client.js').fetchAddonsWithConfigure;

beforeAll(async () => {
  Object.assign(globalThis, {
    window: {
      electronAPI: {
        fs: {
          exists: () => true,
          read: () => '{}',
          write: () => {},
        },
      },
    },
  });
  ({ fetchAddonsWithConfigure } = await import(
    '../src/frontend/lib/config/client.js'
  ));
});

describe('addon configuration handshake', () => {
  test('concurrent manifest-ready handlers share one config-update', async () => {
    const first = Effect.runPromise(fetchAddonsWithConfigure());
    await configUpdateStarted;
    const second = Effect.runPromise(fetchAddonsWithConfigure());

    expect(configUpdateCalls).toBe(1);
    releaseConfigUpdate();

    expect((await first)[0].eventsAvailable).toEqual(['launch-app']);
    expect((await second)[0].eventsAvailable).toEqual(['launch-app']);
    expect(configUpdateCalls).toBe(1);
  });
});
