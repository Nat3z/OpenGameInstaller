import { describe, expect, test } from 'bun:test';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { LibraryError } from '@ogi-sdk/errors';
import { Effect, Fiber, Layer, Stream } from 'effect';
import { Library, LibraryLive, LibraryStore } from '../library/library';
import { Prompts, PromptsLive } from '../prompts/prompts';
import { GameRunner, Launcher, LaunchHooks, LaunchLive } from './launch';

const game: LibraryInfo = {
  appID: 1,
  name: 'Game',
  version: '1',
  cwd: 'relative/1',
  launchExecutable: 'game.exe',
  capsuleImage: '',
  coverImage: '',
  storefront: 'steam',
  addonsource: 'test',
};

/** Builds the launch stack with recording fakes for the two adapters. */
const setup = (options: { failPre?: boolean } = {}) => {
  const calls: string[] = [];
  const store = Layer.succeed(LibraryStore, {
    get: (appID) => Effect.succeed(appID === 1 ? game : null),
    list: Effect.succeed([game]),
    save: () => Effect.void,
    markLaunched: () => Effect.void,
    stageRemoval: () => Effect.die('unused'),
  });
  const library = LibraryLive.pipe(Layer.provide(store));
  const hooks = Layer.succeed(LaunchHooks, {
    run: (_, stage) =>
      Effect.sync(() => calls.push(`hook:${stage}`)).pipe(
        Effect.andThen(
          stage === 'pre' && options.failPre
            ? Effect.fail(new LibraryError({ message: 'save sync failed' }))
            : Effect.void
        )
      ),
  });
  const runner = Layer.effect(
    GameRunner,
    Effect.map(Library, (lib) => ({
      start: (appID: number) =>
        Effect.sync(() => calls.push(`start:${appID}`)).pipe(
          Effect.andThen(lib.notifyLaunched(appID))
        ),
    }))
  ).pipe(Layer.provide(library));
  const layer = Layer.mergeAll(
    LaunchLive.pipe(Layer.provide(Layer.mergeAll(library, hooks, runner))),
    library,
    PromptsLive
  );
  return { calls, layer };
};

const exitGame = (appID: number) =>
  Effect.flatMap(Library, (library) => library.notifyExited(appID)).pipe(
    // Give the post-hook watcher a turn.
    Effect.andThen(Effect.sleep('10 millis'))
  );

describe('Launcher', () => {
  test('pre hooks, start, then post hooks on exit', async () => {
    const { calls, layer } = setup();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* Launcher).launch(1);
        yield* exitGame(1);
      }).pipe(Effect.provide(layer))
    );
    expect(calls).toEqual(['hook:pre', 'start:1', 'hook:post']);
  });

  test('post hooks skip games the launcher did not start', async () => {
    const { calls, layer } = setup();
    await Effect.runPromise(exitGame(1).pipe(Effect.provide(layer)));
    expect(calls).toEqual([]);
  });

  test('a failed pre hook asks, and cancelling stops the launch', async () => {
    const { calls, layer } = setup({ failPre: true });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const prompts = yield* Prompts;
        const { updates } = yield* prompts.watch;
        // Answer "Cancel" as soon as the prompt opens.
        yield* Effect.fork(
          updates.pipe(
            Stream.runForEach((change) =>
              change._tag === 'Opened'
                ? prompts.reply(change.prompt.id, {
                    _tag: 'Confirm',
                    confirmed: false,
                  })
                : Effect.void
            )
          )
        );
        return yield* Effect.flip((yield* Launcher).launch(1));
      }).pipe(Effect.scoped, Effect.provide(layer))
    );
    expect(error.message).toBe('Launch cancelled');
    expect(calls).toEqual(['hook:pre']);
  });

  test('a failed pre hook can be launched anyway', async () => {
    const { calls, layer } = setup({ failPre: true });
    await Effect.runPromise(
      Effect.gen(function* () {
        const prompts = yield* Prompts;
        const { updates } = yield* prompts.watch;
        const answering = yield* Effect.fork(
          updates.pipe(
            Stream.runForEach((change) =>
              change._tag === 'Opened'
                ? prompts.reply(change.prompt.id, {
                    _tag: 'Confirm',
                    confirmed: true,
                  })
                : Effect.void
            )
          )
        );
        yield* (yield* Launcher).launch(1);
        yield* Fiber.interrupt(answering);
      }).pipe(Effect.scoped, Effect.provide(layer))
    );
    expect(calls).toEqual(['hook:pre', 'start:1']);
  });

  test('managed sessions are flagged on the library feed', async () => {
    const { layer } = setup();
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const library = yield* Library;
        const changes = yield* library.changes;
        const collecting = yield* Effect.fork(
          changes.pipe(Stream.take(3), Stream.runCollect)
        );
        yield* (yield* Launcher).launch(1);
        yield* library.notifyExited(1);
        // Not started by the launcher, so not managed.
        yield* library.notifyExited(1);
        return [...(yield* Fiber.join(collecting))];
      }).pipe(Effect.scoped, Effect.provide(layer))
    );
    expect(seen).toEqual([
      { _tag: 'Launched', appID: 1, managed: true },
      { _tag: 'Exited', appID: 1, managed: true },
      { _tag: 'Exited', appID: 1, managed: false },
    ]);
  });
});
