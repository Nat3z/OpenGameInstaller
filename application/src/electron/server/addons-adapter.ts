import { Addons } from '@ogi-sdk/core';
import { AddonError } from '@ogi-sdk/errors';
import { Effect, Layer } from 'effect';
import { getAddonServer } from '@/electron/server/addon-server.js';

/**
 * Core's addon adapter: talks to the in-process addon server directly, the
 * same connections the main process already uses for launch hooks.
 */
export const AddonsFromAddonServer = Layer.succeed(Addons, {
  list: Effect.sync(() =>
    Array.from(getAddonServer().getConnections()).flatMap((connection) => {
      const info = connection.addonInfo;
      return info
        ? [
            {
              id: info.id,
              name: info.name,
              version: info.version,
              description: info.description,
              storefronts: info.storefronts ?? [],
              events: connection.eventsAvailable.map(String),
            },
          ]
        : [];
    })
  ),
  call: (addonId, event, args) =>
    Effect.gen(function* () {
      const connection = getAddonServer().getClient(addonId);
      if (!connection) {
        return yield* Effect.fail(
          new AddonError({ message: `Addon ${addonId} is not running` })
        );
      }
      const send =
        event === 'search'
          ? connection.events.search(args as never)
          : event === 'game-details'
            ? connection.events.gameDetails(args as never)
            : connection.events.catalog();
      const reply = yield* send.pipe(
        Effect.mapError(
          (cause) =>
            new AddonError({
              message: `${event} failed: ${cause.message}`,
              addonName: connection.addonInfo?.name,
            })
        )
      );
      if (reply.statusError) {
        return yield* Effect.fail(
          new AddonError({
            message: reply.statusError,
            addonName: connection.addonInfo?.name,
          })
        );
      }
      return reply.args;
    }),
});
