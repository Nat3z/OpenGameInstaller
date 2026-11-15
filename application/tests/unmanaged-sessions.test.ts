import { expect, mock, test } from 'bun:test';
import { Library, LibraryLive, LibraryStore } from '@ogi-sdk/core';
import { Deferred, Effect, Fiber, Layer } from 'effect';

mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

const hooks: number[] = [];
// Set to hold post hooks open, like a slow save backup.
let hooksGate: Deferred.Deferred<void> | undefined;
mock.module('../src/electron/server/addon-lifecycle.js', () => ({
  runLaunchAppHooks: (game: { appID: number }) =>
    (hooksGate ? Deferred.await(hooksGate) : Effect.void).pipe(
      Effect.map(() => {
        hooks.push(game.appID);
        return { success: true };
      })
    ),
}));

// No addon processes here: nothing to restart or wait for.
mock.module('../src/electron/handlers/handler.addon.js', () => ({
  startAddons: () => Effect.void,
}));
mock.module('../src/electron/manager/manager.addon-readiness.js', () => ({
  waitForAddonManifests: () => Effect.succeed([]),
}));

const services = LibraryLive.pipe(
  Layer.provide(
    Layer.succeed(LibraryStore, {
      get: (appID: number) => Effect.succeed({ appID } as never),
    } as never)
  ),
  // Read after the electron mock: the settings module pulls in electron.
  Layer.merge(
    Layer.unwrapEffect(
      Effect.promise(async () => {
        const { Settings } = await import(
          '../src/electron/services/settings.js'
        );
        return Layer.succeed(Settings, {} as never);
      })
    )
  )
);

const run = <A, R>(effect: Effect.Effect<A, never, R>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, services) as Effect.Effect<A>);

test('an exited desktop session runs its post hooks once, then frees the game', async () => {
  hooks.length = 0;
  const { finishOnExit } = await import(
    '../src/electron/server/unmanaged-sessions.js'
  );
  const reservedAfter = await run(
    Effect.gen(function* () {
      const library = yield* Library;
      const token = (yield* library.reserve(1)) as string;
      yield* finishOnExit(1, token);
      yield* library.notifyLaunched(1);
      // Still held while the game runs.
      const whileRunning = yield* library.reserve(1);
      yield* library.notifyExited(1);
      yield* Effect.sleep('20 millis');
      return { whileRunning, after: yield* library.reserve(1) };
    })
  );
  expect(hooks).toEqual([1]);
  expect(reservedAfter.whileRunning).toBeNull();
  expect(reservedAfter.after).not.toBeNull();
});

test('a cancelled session frees the game without running hooks', async () => {
  hooks.length = 0;
  const { finishOnExit } = await import(
    '../src/electron/server/unmanaged-sessions.js'
  );
  const after = await run(
    Effect.gen(function* () {
      const library = yield* Library;
      const token = (yield* library.reserve(2)) as string;
      const session = yield* finishOnExit(2, token);
      yield* session.cancel;
      yield* Effect.sleep('20 millis');
      return yield* library.reserve(2);
    })
  );
  expect(hooks).toEqual([]);
  expect(after).not.toBeNull();
});

test('a window gone mid-launch frees its holds, but not one handed to a session', async () => {
  const { dropWindowHold, holdForWindow, releaseWindowHolds } = await import(
    '../src/electron/server/unmanaged-sessions.js'
  );
  const [waiting, started] = await run(
    Effect.gen(function* () {
      const library = yield* Library;
      // Game 3's flow is stuck in a pre hook; game 4 already launched.
      const pending = (yield* library.reserve(3)) as string;
      holdForWindow(3, pending);
      const handed = (yield* library.reserve(4)) as string;
      holdForWindow(4, handed);
      dropWindowHold(handed);
      yield* releaseWindowHolds;
      return [yield* library.reserve(3), yield* library.reserve(4)];
    })
  );
  expect(waiting).not.toBeNull();
  expect(started).toBeNull();
});

test('a wrapped game outlives its window: main runs its post hooks, then frees it', async () => {
  hooks.length = 0;
  const { holdForWindow, releaseWindowHolds, whileWrapped } = await import(
    '../src/electron/server/unmanaged-sessions.js'
  );
  const result = await run(
    Effect.gen(function* () {
      const library = yield* Library;
      const token = (yield* library.reserve(5)) as string;
      holdForWindow(5, token);
      const gameExit = yield* Deferred.make<void>();
      const game = yield* Effect.fork(
        whileWrapped(token, Deferred.await(gameExit))
      );
      yield* Effect.sleep('5 millis');
      // The window closes while the wrapped game runs: still held.
      yield* releaseWindowHolds;
      const whileRunning = yield* library.reserve(5);
      yield* Deferred.succeed(gameExit, undefined);
      yield* Fiber.join(game);
      return { whileRunning, after: yield* library.reserve(5) };
    })
  );
  expect(result.whileRunning).toBeNull();
  expect(hooks).toEqual([5]);
  expect(result.after).not.toBeNull();
});

test("a quit waits for an abandoned wrapped game's post hooks", async () => {
  const {
    awaitEndingSessions,
    holdForWindow,
    releaseWindowHolds,
    whileWrapped,
  } = await import('../src/electron/server/unmanaged-sessions.js');
  hooksGate = Effect.runSync(Deferred.make<void>());
  const gate = hooksGate;
  const waited = await run(
    Effect.gen(function* () {
      const library = yield* Library;
      const token = (yield* library.reserve(6)) as string;
      holdForWindow(6, token);
      const gameExit = yield* Deferred.make<void>();
      const game = yield* Effect.fork(
        whileWrapped(token, Deferred.await(gameExit))
      );
      yield* Effect.sleep('5 millis');
      // The window goes mid-game, then the game exits: main runs its post
      // hooks (a backup), held open here.
      yield* releaseWindowHolds;
      yield* Deferred.succeed(gameExit, undefined);
      yield* Effect.sleep('20 millis');
      const quit = yield* Effect.fork(awaitEndingSessions('5 seconds'));
      yield* Effect.sleep('20 millis');
      const early = quit.unsafePoll() !== null;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(quit);
      yield* Fiber.join(game);
      return early;
    })
  );
  hooksGate = undefined;
  expect(waited).toBe(false);
});
