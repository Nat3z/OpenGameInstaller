import { EffectConnection } from '@ogi-sdk/client-kit';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { Addons, LaunchHooks } from '@ogi-sdk/core';
import { AddonError, LibraryError } from '@ogi-sdk/errors';
import { Effect, Layer } from 'effect';
import WebSocket from 'ws';
import { forkElectronEffect, runElectronEffect } from '@/electron/runtime.js';
import { port } from '@/electron/server/addon-server.js';
import { Prompts } from '@/electron/services/index.js';

/**
 * Under `ogi dev` (`--no-server`) the CLI owns the addon server, so core
 * reaches addons the way any other host would: as an SDK client of it. The
 * renderer keeps its own connection; this one is core's.
 */
let connection: Promise<EffectConnection> | undefined;

const connect = (): Promise<EffectConnection> =>
  Effect.runPromise(
    EffectConnection.make({
      url: `ws://127.0.0.1:${port}`,
      webSocket: WebSocket as never,
    }).pipe(
      // the CLI's server asks an SDK client for addon input; send it to core's
      // prompts so whichever client is open can answer
      Effect.tap((client) =>
        client.on('input-asked', ({ name, description, config, reply }) =>
          Effect.promise(() =>
            runElectronEffect(
              Effect.flatMap(Prompts, (prompts) =>
                prompts.ask({ _tag: 'Input', title: name, description, config })
              )
            )
          ).pipe(
            Effect.flatMap((answer) =>
              reply(answer._tag === 'Input' ? answer.values : {})
            ),
            Effect.ignore
          )
        )
      )
    )
  );

const sdk: Effect.Effect<EffectConnection, AddonError> = Effect.tryPromise({
  try: () => (connection ??= connect()),
  catch: (cause) => {
    connection = undefined;
    return new AddonError({
      message: `ogi dev addon server unreachable: ${String(cause)}`,
    });
  },
});

const toAddonError = (error: { message: string }): AddonError =>
  new AddonError({ message: error.message });

const connectedAddons = sdk.pipe(
  Effect.flatMap((client) =>
    client.request('query-connected-addons', { type: 'addons' })
  ),
  Effect.flatMap((response) =>
    response.statusError
      ? Effect.fail(new AddonError({ message: response.statusError }))
      : Effect.succeed(response.args.addons)
  ),
  Effect.mapError(toAddonError)
);

/** Core's addon adapter under `ogi dev`. */
export const AddonsFromDevServer = Layer.succeed(Addons, {
  list: connectedAddons.pipe(
    Effect.map((addons) =>
      addons.map((addon) => ({
        id: addon.id,
        name: addon.name,
        version: addon.version,
        description: addon.description,
        storefronts: addon.storefronts ?? [],
        events: addon.eventsAvailable,
      }))
    ),
    Effect.orElseSucceed(() => [])
  ),
  call: (addonId, event, args) =>
    sdk.pipe(
      Effect.flatMap((client): Effect.Effect<unknown, { message: string }> => {
        const addon = client.addon(addonId);
        return event === 'search'
          ? addon.search(args as never)
          : event === 'game-details'
            ? addon.gameDetails(args as never)
            : addon.catalog();
      }),
      Effect.mapError(toAddonError)
    ),
});

/** Core's hook adapter under `ogi dev`: every addon's `launch-app`. */
export const LaunchHooksFromDevServer = Layer.succeed(LaunchHooks, {
  run: (game: LibraryInfo, stage) =>
    Effect.all([sdk, connectedAddons]).pipe(
      Effect.flatMap(([client, addons]) =>
        Effect.forEach(
          addons.filter((addon) =>
            addon.eventsAvailable.includes('launch-app')
          ),
          (addon) =>
            client
              .addon(addon.id)
              .launchApp({ libraryInfo: game, launchType: stage }),
          { concurrency: 'unbounded', discard: true }
        )
      ),
      Effect.mapError(
        (error) =>
          new LibraryError({
            message: `${stage}-launch hook failed: ${error.message}`,
            gameId: game.appID,
          })
      )
    ),
});

export const closeDevAddons = (): void => {
  const open = connection;
  connection = undefined;
  if (open)
    forkElectronEffect(
      Effect.promise(() => open).pipe(
        Effect.flatMap((client) => client.close()),
        Effect.ignore
      )
    );
};
