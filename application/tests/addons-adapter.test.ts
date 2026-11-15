import { expect, mock, test } from 'bun:test';
import { Effect, Fiber, Layer, TestClock, TestContext } from 'effect';

mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// An addon announces its events only after its first `config-update`. The
// first call to a fresh addon must see them, not the empty list from before.
// `refuse` configs fail, like a replay that hits an addon still starting.
const fresh = (refuse = 0) => {
  const addon = {
    addonInfo: { id: 'steam', name: 'Steam', storefronts: ['steam'] },
    configTemplate: {},
    eventsAvailable: [] as string[],
    events: {
      configUpdate: (): Effect.Effect<{ args: unknown }, Error> =>
        refuse-- > 0
          ? Effect.fail(new Error('not ready'))
          : Effect.sync(() => {
              addon.eventsAvailable = ['search'];
              return { args: { success: true } };
            }),
      search: (): Effect.Effect<{ args: unknown }> =>
        Effect.succeed({ args: [{ name: 'Direct' }] }),
    },
  };
  return addon;
};
let connection = fresh();
// Like the real server: remembers accepted configs and replays the last one
// to a reconnecting addon, ignoring a failed replay.
const lastConfigs = new Map<string, unknown>();
const server = {
  getClient: (id: string) => (id === 'steam' ? connection : undefined),
  getConnections: () => new Set([connection]),
  rememberConfig: (id: string, config: unknown) => lastConfigs.set(id, config),
  reconnect: (next: ReturnType<typeof fresh>) =>
    Effect.gen(function* () {
      connection = next;
      if (lastConfigs.has('steam'))
        yield* next.events.configUpdate().pipe(Effect.ignore);
    }),
};
mock.module('../src/electron/server/addon-server.js', () => ({
  getAddonServer: () => server,
}));

const layer = async () => {
  const { AddonsFromAddonServer } = await import(
    '../src/electron/server/addons-adapter.js'
  );
  const { Database } = await import('../src/electron/services/index.js');
  const database = Layer.succeed(Database, {
    addonConfig: { get: () => Effect.succeed({}), set: () => Effect.void },
  } as never);
  return AddonsFromAddonServer.pipe(Layer.provide(database));
};

const search = async () => {
  const { AddonsHandlers } = await import('@ogi-sdk/core');
  const handler = AddonsHandlers.handlers.search as (
    params: unknown
  ) => Effect.Effect<unknown, unknown, never>;
  return Effect.runPromise(
    handler({ addonId: 'steam', appID: 1, storefront: 'steam' }).pipe(
      Effect.provide(await layer())
    ) as Effect.Effect<unknown>
  );
};

test('the first search after a failed replay configures the new connection', async () => {
  // Configured once through core, so the server remembers its config.
  expect(await search()).toEqual([{ name: 'Direct' }]);
  expect(lastConfigs.has('steam')).toBe(true);

  // It reconnects and the replay fails: the new connection knows nothing.
  await Effect.runPromise(server.reconnect(fresh(1)));
  expect(connection.eventsAvailable).toEqual([]);

  // Core's capability check sees `search` because core configured it again.
  expect(await search()).toEqual([{ name: 'Direct' }]);
  expect(connection.eventsAvailable).toContain('search');
});

test('an addon that never answers a call fails instead of hanging', async () => {
  connection = fresh();
  connection.events.search = () => Effect.never;
  const { Addons } = await import('@ogi-sdk/core');
  const addons = await layer();

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
      Effect.provide(addons),
      Effect.provide(TestContext.TestContext)
    ) as Effect.Effect<{ message: string }>
  );
  expect(error.message).toContain('did not answer search');
});

test('a call waiting on a person answering the addon does not time out', async () => {
  connection = fresh();
  const { whileAsking } = await import(
    '../src/electron/server/addon-prompts.js'
  );
  const { Addons } = await import('@ogi-sdk/core');
  const addons = await layer();

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      // The addon asks a question 10s in; the person answers 5 minutes later.
      connection.events.search = () =>
        Effect.sleep('10 seconds').pipe(
          Effect.flatMap(() => whileAsking(Effect.sleep('5 minutes'))),
          Effect.map(() => ({ args: [{ name: 'Answered' }] }))
        );
      const waiting = yield* Effect.fork(
        Effect.flatMap(Addons, (addons) => addons.call('steam', 'search', {}))
      );
      yield* TestClock.adjust('10 seconds');
      yield* TestClock.adjust('5 minutes');
      return yield* Fiber.join(waiting);
    }).pipe(
      Effect.provide(addons),
      Effect.provide(TestContext.TestContext)
    ) as Effect.Effect<unknown>
  );
  expect(result).toEqual([{ name: 'Answered' }]);
});
