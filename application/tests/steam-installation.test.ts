import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Deferred, Effect, Fiber } from 'effect';
import {
  type SteamLocation,
  SteamRepository,
  SteamRepositoryLive,
} from '../src/electron/lib/steam-installation.js';
import {
  parseBinaryVdf,
  serializeBinaryVdf,
} from '../src/electron/lib/steam-vdf.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Steam shortcuts repository', () => {
  const createLocation = (): SteamLocation => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ogi-steam-repository-')
    );
    temporaryDirectories.push(directory);
    return {
      root: directory,
      loginUsersPath: path.join(directory, 'config/loginusers.vdf'),
      user: {
        accountId: '1',
        mostRecent: true,
        timestamp: 0,
        userdataPath: directory,
        shortcutsPath: path.join(directory, 'config/shortcuts.vdf'),
      },
    };
  };

  test('serializes complete shortcut transactions across runtimes', async () => {
    const location = createLocation();
    const shortcutsPath = location.user.shortcutsPath;
    const layer = SteamRepositoryLive([]);
    const increment = Effect.gen(function* () {
      const repository = yield* SteamRepository;
      return yield* repository.modifyShortcuts(location, ({ root, commit }) =>
        Effect.gen(function* () {
          const current = root.get('transaction-test');
          const value = current?.type === 2 ? current.value : 0;
          yield* Effect.sleep('20 millis');
          root.set('transaction-test', { type: 2, value: value + 1 });
          yield* commit();
        })
      );
    });
    const run = () => Effect.runPromise(increment.pipe(Effect.provide(layer)));

    await Promise.all([run(), run()]);

    const root = parseBinaryVdf(fs.readFileSync(shortcutsPath));
    expect(root.get('transaction-test')).toEqual({ type: 2, value: 2 });
  });

  test('rolls back a committed shortcuts file when interrupted', async () => {
    const location = createLocation();
    const layer = SteamRepositoryLive([]);

    await Effect.runPromise(
      Effect.gen(function* () {
        const committed = yield* Deferred.make<void>();
        const repository = yield* SteamRepository;
        const fiber = yield* Effect.fork(
          repository.modifyShortcuts(location, ({ root, commit }) =>
            Effect.gen(function* () {
              root.set('transaction-test', { type: 2, value: 1 });
              yield* commit();
              yield* Deferred.succeed(committed, undefined);
              yield* Effect.never;
            })
          )
        );
        yield* Deferred.await(committed);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer))
    );

    expect(fs.existsSync(location.user.shortcutsPath)).toBe(false);
  });

  test('rollback removes shortcuts file when it was initially absent', async () => {
    const location = createLocation();
    const layer = SteamRepositoryLive([]);
    const transaction = Effect.gen(function* () {
      const repository = yield* SteamRepository;
      return yield* repository.modifyShortcuts(
        location,
        ({ root, commit, rollback }) =>
          Effect.gen(function* () {
            root.set('transaction-test', { type: 2, value: 1 });
            yield* commit();
            expect(fs.existsSync(location.user.shortcutsPath)).toBe(true);
            yield* rollback;
          })
      );
    });

    await Effect.runPromise(transaction.pipe(Effect.provide(layer)));

    expect(fs.existsSync(location.user.shortcutsPath)).toBe(false);
  });

  test('rollback restores an existing shortcuts file', async () => {
    const location = createLocation();
    const original = serializeBinaryVdf(
      new Map([['transaction-test', { type: 2 as const, value: 7 }]])
    );
    fs.mkdirSync(path.dirname(location.user.shortcutsPath), {
      recursive: true,
    });
    fs.writeFileSync(location.user.shortcutsPath, original);
    const layer = SteamRepositoryLive([]);

    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* SteamRepository;
        yield* repository.modifyShortcuts(
          location,
          ({ root, commit, rollback }) =>
            Effect.gen(function* () {
              root.set('transaction-test', { type: 2, value: 8 });
              yield* commit();
              yield* rollback;
            })
        );
      }).pipe(Effect.provide(layer))
    );

    expect(fs.readFileSync(location.user.shortcutsPath)).toEqual(original);
  });
});
