import { Database as Sqlite } from 'bun:sqlite';
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import * as path from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Effect } from 'effect';
import { AppDatabase } from '../src/electron/database/database.js';

// The live layer imports the database opener, which imports `electron`.
mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

let AppServicesTest: typeof import('../src/electron/services/index.js').AppServicesTest;
let Database: typeof import('../src/electron/services/index.js').Database;
let Library: typeof import('../src/electron/services/index.js').Library;
let Settings: typeof import('../src/electron/services/index.js').Settings;

beforeAll(async () => {
  ({ AppServicesTest, Database, Library, Settings } = await import(
    '../src/electron/services/index.js'
  ));
});

const migrations = path.join(import.meta.dir, '../drizzle');
const services = () =>
  AppServicesTest(new AppDatabase(drizzle(new Sqlite(':memory:')), migrations));

const game = (appID: number) => ({
  appID,
  name: `Game ${appID}`,
  version: '1',
  cwd: `/games/${appID}`,
  launchExecutable: 'game.exe',
  capsuleImage: '',
  coverImage: '',
  storefront: 'steam',
  addonsource: 'test',
});

describe('application services', () => {
  test('Settings and Library share one database', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* Settings;
        const library = yield* Library;
        yield* settings.setAddons(['git@a/b']);
        yield* library.save(game(1));
        yield* library.save(game(2));
        yield* library.markLaunched(2);
        return {
          addons: yield* settings.addons,
          tool: yield* settings.steamCompatibilityTool,
          order: (yield* library.list).map((entry) => entry.appID),
        };
      }).pipe(Effect.provide(services()))
    );
    expect(result).toEqual({
      addons: ['git@a/b'],
      tool: 'proton_experimental',
      order: [2, 1],
    });
  });

  test('Library.require fails with GameNotFound', async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Library).require(404);
      }).pipe(Effect.flip, Effect.provide(services()))
    );
    expect(error._tag).toBe('GameNotFound');
  });

  test('a throwing database call surfaces as DatabaseError', async () => {
    const broken = new Proxy({} as AppDatabase, {
      get: () => () => {
        throw new Error('disk on fire');
      },
    });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Database).settings.get;
      }).pipe(Effect.flip, Effect.provide(AppServicesTest(broken)))
    );
    expect(error._tag).toBe('DatabaseError');
    expect(error.operation).toBe('settings.get');
    expect(error.message).toBe('disk on fire');
  });
});
