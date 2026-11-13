import { GameRunner, LaunchHooks } from '@ogi-sdk/core';
import { LibraryError } from '@ogi-sdk/errors';
import { Effect, Layer } from 'effect';
import { launchGameFromLibrary } from '@/electron/handlers/handler.library.js';
import { runElectronEffect } from '@/electron/runtime.js';
import { runLaunchAppHooks } from '@/electron/server/addon-lifecycle.js';

/** Core's hook adapter: the in-process addon server's `launch-app` event. */
export const LaunchHooksFromAddonServer = Layer.succeed(LaunchHooks, {
  run: (game, stage) =>
    runLaunchAppHooks(game, stage).pipe(
      Effect.flatMap((result) =>
        result.success
          ? Effect.void
          : Effect.fail(
              new LibraryError({
                message: result.error ?? `${stage}-launch hook failed`,
                gameId: game.appID,
              })
            )
      )
    ),
});

/**
 * Core's runner adapter: the existing umu / legacy spawn path. It already
 * reports launch and exit to the library, which core uses for post hooks.
 */
export const GameRunnerFromLibrary = Layer.succeed(GameRunner, {
  start: (appID) =>
    Effect.promise(() => runElectronEffect(launchGameFromLibrary(appID))).pipe(
      Effect.flatMap((result) =>
        result.success
          ? Effect.void
          : Effect.fail(
              new LibraryError({
                message: result.error ?? 'Failed to launch game',
                gameId: appID,
              })
            )
      )
    ),
});
