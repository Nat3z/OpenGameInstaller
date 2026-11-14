import type { ConfigurationFile } from '@ogi-sdk/connect';
import { Addons } from '@ogi-sdk/core';
import { AddonError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { type Context, Effect, Layer } from 'effect';
import { waitForAddonManifests } from '@/electron/manager/manager.addon-readiness.js';
import { getAddonServer } from '@/electron/server/addon-server.js';
import { Database } from '@/electron/services/index.js';
import { buildDefaultConfig } from '@/lib/addon-config.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/**
 * An addon announces its events only after its first `config-update`. The
 * renderer used to send that; without one (headless, or before the window
 * loads) core sends the saved config, seeding defaults like the renderer does.
 */
const configureAddons = (database: Context.Tag.Service<Database>) =>
  Effect.gen(function* () {
    const server = getAddonServer();
    const connections = yield* waitForAddonManifests();
    yield* Effect.forEach(
      connections,
      (connection) =>
        Effect.gen(function* () {
          const id = connection.addonInfo?.id;
          const template = connection.configTemplate;
          if (!id || !template || server.isConfigured(id)) return;
          let config = yield* database.addonConfig.get(id);
          if (!config) {
            config = buildDefaultConfig(template);
            yield* database.addonConfig.set(id, config);
          }
          yield* connection.configure(config as unknown as ConfigurationFile);
          server.rememberConfig(id, config as unknown as ConfigurationFile);
        }).pipe(
          Effect.catchAll((error) =>
            logger.warn(
              `[addons] Could not configure ${connection.addonInfo?.id}`,
              error
            )
          )
        ),
      { concurrency: 'unbounded', discard: true }
    );
  });

/**
 * Core's addon adapter: talks to the in-process addon server directly, the
 * same connections the main process already uses for launch hooks.
 */
export const AddonsFromAddonServer = Layer.effect(
  Addons,
  Effect.map(Database, (database) => {
    const configure = configureAddons(database);
    return {
      list: configure.pipe(
        Effect.zipRight(
          Effect.sync(() =>
            Array.from(getAddonServer().getConnections()).flatMap(
              (connection) => {
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
              }
            )
          )
        )
      ),
      call: (addonId, event, args) =>
        Effect.gen(function* () {
          yield* configure;
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
    };
  })
);
