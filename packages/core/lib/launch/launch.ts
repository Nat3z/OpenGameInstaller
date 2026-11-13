import type { LibraryInfo } from '@ogi-sdk/connect';
import { LibraryError } from '@ogi-sdk/errors';
import { LibraryGroup } from '@ogi-sdk/protocol';
import { Context, Effect, Layer, Stream } from 'effect';
import { Library } from '../library/library';
import { Prompts } from '../prompts/prompts';
import { type Implementation, implement } from '../server/router';

/**
 * Adapter: runs every addon's `launch-app` hook for a game. The Electron host
 * calls its in-process addon server; fails with the first hook's error.
 */
export type LaunchHooksShape = {
  readonly run: (
    game: LibraryInfo,
    stage: 'pre' | 'post'
  ) => Effect.Effect<void, LibraryError>;
};

export class LaunchHooks extends Context.Tag('@ogi-sdk/core/LaunchHooks')<
  LaunchHooks,
  LaunchHooksShape
>() {}

/**
 * Adapter: starts the game process (umu, legacy spawn, Steam shortcut). It
 * reports start and exit through `Library.notifyLaunched/notifyExited`,
 * which is what triggers post-launch hooks.
 */
export type GameRunnerShape = {
  readonly start: (appID: number) => Effect.Effect<void, LibraryError>;
};

export class GameRunner extends Context.Tag('@ogi-sdk/core/GameRunner')<
  GameRunner,
  GameRunnerShape
>() {}

/**
 * The launch flow every frontend shares:
 *   pre hooks -> (on failure, ask whether to launch anyway) -> start
 *   ... game exits -> post hooks
 */
export type LauncherShape = {
  readonly launch: (
    appID: number
  ) => Effect.Effect<void, LibraryError, Library | Prompts>;
};

export class Launcher extends Context.Tag('@ogi-sdk/core/Launcher')<
  Launcher,
  LauncherShape
>() {}

/**
 * Builds the `Launcher` and its post-hook watcher. Post hooks run only for
 * managed sessions (ones this launcher started); the desktop renderer still
 * runs hooks for launches it starts and skips managed ones.
 */
export const LaunchLive: Layer.Layer<
  Launcher,
  never,
  Library | LaunchHooks | GameRunner
> = Layer.scoped(
  Launcher,
  Effect.gen(function* () {
    const hooks = yield* LaunchHooks;
    const runner = yield* GameRunner;
    const library = yield* Library;

    // Lives as long as the layer: one post-hook run per exit, in order.
    yield* Effect.forkScoped(
      (yield* library.changes).pipe(
        Stream.runForEach((change) =>
          change._tag === 'Exited' && change.managed
            ? library.get(change.appID).pipe(
                Effect.flatMap((game) =>
                  game ? hooks.run(game, 'post') : Effect.void
                ),
                Effect.ignore
              )
            : Effect.void
        )
      )
    );

    return {
      launch: (appID) =>
        Effect.gen(function* () {
          const game = yield* library.require(appID).pipe(
            Effect.mapError(
              (cause) =>
                new LibraryError({
                  message:
                    cause._tag === 'GameNotFound'
                      ? 'Game not found'
                      : cause.message,
                  gameId: appID,
                })
            )
          );

          const pre = yield* Effect.either(hooks.run(game, 'pre'));
          if (pre._tag === 'Left') {
            const answer = yield* Effect.flatMap(Prompts, (prompts) =>
              prompts.ask({
                _tag: 'Confirm',
                title: 'Addon pre-launch step failed',
                message: pre.left.message,
                detail: 'Launch the game anyway?',
                confirmLabel: 'Launch anyway',
                cancelLabel: 'Cancel',
              })
            );
            if (answer._tag !== 'Confirm' || !answer.confirmed) {
              return yield* Effect.fail(
                new LibraryError({ message: 'Launch cancelled', gameId: appID })
              );
            }
          }

          yield* library.claimHooks(appID);
          yield* runner
            .start(appID)
            .pipe(Effect.tapError(() => library.releaseHooks(appID)));
        }),
    };
  })
);

export const LaunchHandlers: Implementation<Launcher | Library | Prompts> =
  implement<typeof LibraryGroup, Launcher | Library | Prompts>(LibraryGroup, {
    launch: ({ appID }) =>
      Effect.flatMap(Launcher, (launcher) => launcher.launch(appID)),
  });
