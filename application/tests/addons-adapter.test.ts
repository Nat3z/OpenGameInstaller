import { expect, mock, test } from 'bun:test';
import { Effect, Fiber, Layer, TestClock, TestContext } from 'effect';

mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// An addon announces its events only after its first `config-update`. The
// first call to a fresh addon must see them, not the empty list from before.
const connection = {
  addonInfo: { id: 'steam', name: 'Steam', storefronts: ['steam'] },
  configTemplate: {},
  eventsAvailable: [] as string[],
  events: {
    configUpdate: () =>
      Effect.sync(() => {
        connection.eventsAvailable = ['search'];
        return { args: { success: true } };
      }),
    search: () => Effect.succeed({ args: [{ name: 'Direct' }] }),
  },
};
// What the real server keeps for replay: it says nothing about whether this
// connection got the config (a replay to it may have failed).
const lastConfigs = new Map<string, unknown>();
const server = {
  getClient: (id: string) => (id === 'steam' ? connection : undefined),
  getConnections: () => new Set([connection]),
  rememberConfig: (id: string, config: unknown) => lastConfigs.set(id, config),
};
mock.module('../src/electron/server/addon-server.js', () => ({
  getAddonServer: () => server,
}));

test('the first search to a fresh addon goes through core', async () => {
  // A reconnect whose replay failed: the server still remembers a config for
  // this addon, yet the new connection has announced nothing.
  lastConfigs.set('steam', {});
  const { AddonsFromAddonServer } = await import(
    '../src/electron/server/addons-adapter.js'
  );
  const { AddonsHandlers } = await import('@ogi-sdk/core');
  const { Database } = await import('../src/electron/services/index.js');
  const database = Layer.succeed(Database, {
    addonConfig: { get: () => Effect.succeed({}), set: () => Effect.void },
  } as never);
  const search = AddonsHandlers.handlers.search as (
    params: unknown
  ) => Effect.Effect<unknown, unknown, never>;

  const results = await Effect.runPromise(
    search({ addonId: 'steam', appID: 1, storefront: 'steam' }).pipe(
      Effect.provide(AddonsFromAddonServer.pipe(Layer.provide(database)))
    ) as Effect.Effect<unknown>
  );
  // Core's capability check saw `search` because configuring announced it.
  expect(results).toEqual([{ name: 'Direct' }]);
  expect(connection.eventsAvailable).toContain('search');
});

test('an addon that never answers a call fails instead of hanging', async () => {
  const { AddonsFromAddonServer } = await import(
    '../src/electron/server/addons-adapter.js'
  );
  const { Addons } = await import('@ogi-sdk/core');
  const { Database } = await import('../src/electron/services/index.js');
  const database = Layer.succeed(Database, {
    addonConfig: { get: () => Effect.succeed({}), set: () => Effect.void },
  } as never);
  connection.events.search = () => Effect.never as never;

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const waiting = yield* Effect.fork(
        Effect.flatMap(Addons, (addons) =>
          addons.call('steam', 'search', {})
        ).pipe(Effect.flip)
      );
      yield* TestClock.adjust('61 seconds');
      return yield* Fiber.join(waiting);
    }).pipe(
      Effect.provide(AddonsFromAddonServer.pipe(Layer.provide(database))),
      Effect.provide(TestContext.TestContext)
    ) as Effect.Effect<{ message: string }>
  );
  expect(error.message).toContain('did not answer search');
});
