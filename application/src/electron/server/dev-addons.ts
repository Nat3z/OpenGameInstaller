import { EffectConnection } from '@ogi-sdk/client-kit';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { Addons, LaunchHooks } from '@ogi-sdk/core';
import { AddonError, LibraryError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Layer } from 'effect';
import WebSocket from 'ws';
import { forkElectronEffect, runElectronEffect } from '@/electron/runtime.js';
import { port } from '@/electron/server/addon-server.js';
import { Prompts } from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/**
 * Under `ogi dev` (`--no-server`) the CLI owns the addon server, so core
 * reaches addons the way any other host would: as an SDK client of it. The
 * renderer keeps its own connection; this one is core's.
 */
let connection: Promise<EffectConnection> | undefined;

/**
 * Forgets the cached connection once its socket closes (CLI restart, dropped
 * link), so the next request reconnects instead of reusing a dead socket.
 */
let socket: WebSocket | undefined;
class ReconnectingSocket extends WebSocket {
  constructor(url: string) {
    super(url);
    socket = this;
    this.once('close', () => {
      if (socket !== this) return;
      socket = undefined;
      connection = undefined;
    });
  }
}

const connect = (): Promise<EffectConnection> =>
  Effect.runPromise(
    EffectConnection.make({
      url: `ws://127.0.0.1:${port}`,
      webSocket: ReconnectingSocket as never,
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

/**
 * Connects now rather than on the first core request. The CLI's server sends
 * addon input to its first SDK client, so core must be connected before the
 * renderer is, or prompts skip `prompts.watch` and only reach the window.
 */
export const connectDevAddons = (): Effect.Effect<void> =>
  sdk.pipe(
    Effect.tapError((error) => logger.warn(`[ogi dev] ${error.message}`)),
    Effect.ignore
  );

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
