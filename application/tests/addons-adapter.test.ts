import { expect, mock, test } from 'bun:test';
import { Effect, Layer } from 'effect';

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
const server = {
  getClient: (id: string) => (id === 'steam' ? connection : undefined),
  getConnections: () => new Set([connection]),
  rememberConfig: () => {},
};
mock.module('../src/electron/server/addon-server.js', () => ({
  getAddonServer: () => server,
}));

test('the first search to a fresh addon goes through core', async () => {
  // A replay that never arrived: the addon is up but has announced nothing.
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
});
