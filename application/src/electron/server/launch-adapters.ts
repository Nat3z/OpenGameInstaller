import { GameRunner, LaunchHooks } from '@ogi-sdk/core';
import { LibraryError } from '@ogi-sdk/errors';
import { Effect, Layer } from 'effect';
import { launchGameFromLibrary } from '@/electron/handlers/handler.library.js';
import { runElectronEffect } from '@/electron/runtime.js';
import { runLaunchAppHooks } from '@/electron/server/addon-lifecycle.js';
import { configureAddons } from '@/electron/server/addons-adapter.js';

/**
 * Core's hook adapter: the in-process addon server's `launch-app` event.
 * First waits for running addons and sends any unconfigured one its settings
 * (bounded): an addon only announces `launch-app` after its first config, so
 * an early or late-connecting addon would otherwise be silently skipped.
 */
export const LaunchHooksFromAddonServer = Layer.succeed(LaunchHooks, {
  run: (game, stage) =>
    Effect.promise(() => runElectronEffect(configureAddons)).pipe(
      Effect.zipRight(runLaunchAppHooks(game, stage)),
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
    Effect.tryPromise({
      try: () => runElectronEffect(launchGameFromLibrary(appID)),
      // A rejected launch (Steam shortcut inspection, migration) is a
      // failure the caller sees, not a defect that drops the reply.
      catch: (cause) =>
        new LibraryError({
          message: cause instanceof Error ? cause.message : String(cause),
          gameId: appID,
        }),
    }).pipe(
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
