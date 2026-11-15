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

test('describe configures the addon before reading its events', async () => {
  const { AddonsFromAddonServer } = await import(
    '../src/electron/server/addons-adapter.js'
  );
  const { Addons } = await import('@ogi-sdk/core');
  const { Database } = await import('../src/electron/services/index.js');
  const database = Layer.succeed(Database, {
    addonConfig: {
      get: () => Effect.succeed({}),
      set: () => Effect.void,
    },
  } as never);

  const addon = await Effect.runPromise(
    Effect.flatMap(Addons, (addons) => addons.describe('steam')).pipe(
      Effect.provide(AddonsFromAddonServer.pipe(Layer.provide(database)))
    )
  );
  expect(addon?.events).toEqual(['search']);
});
