import type { AddonConnection } from '@ogi-sdk/addon-server';
import type { ConfigurationFile } from '@ogi-sdk/connect';
import { Addons } from '@ogi-sdk/core';
import { AddonError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { type Context, Effect, Layer } from 'effect';
import { getAddonServer } from '@/electron/server/addon-server.js';
import { Database } from '@/electron/services/index.js';
import { buildDefaultConfig } from '@/lib/addon-config.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/**
 * An addon announces its events only after its first `config-update`. The
 * renderer used to send that; without one (headless, or before the window
 * loads) core sends the saved config, seeding defaults like the renderer does.
 */
const configureOne = (
  database: Context.Tag.Service<Database>,
  connection: AddonConnection
) =>
  Effect.gen(function* () {
    const server = getAddonServer();
    const id = connection.addonInfo?.id;
    const template = connection.configTemplate;
    if (!id || !template || server.isConfigured(id)) return;
    let config = yield* database.addonConfig.get(id);
    if (!config) {
      config = buildDefaultConfig(template);
      yield* database.addonConfig.set(id, config);
    }
    const reply = yield* connection.events.configUpdate(
      config as unknown as ConfigurationFile
    );
    // Addons reject settings as `success: false`; never replay those.
    const accepted =
      !reply.statusError &&
      (reply.args as { success?: boolean } | undefined)?.success !== false;
    if (accepted)
      server.rememberConfig(id, config as unknown as ConfigurationFile);
    else
      yield* logger.warn(
        `[addons] ${id} rejected its settings`,
        reply.statusError ?? (reply.args as { error?: string })?.error
      );
  });

const warnFailure = (connection: AddonConnection) => (error: unknown) =>
  logger.warn(
    `[addons] Could not configure ${connection.addonInfo?.id}`,
    error
  );

/**
 * Addons that are connected now. Never waits on a slow addon's manifest; one
 * that hasn't sent it yet is configured on a later request.
 */
const configureConnected = (database: Context.Tag.Service<Database>) =>
  Effect.forEach(
    Array.from(getAddonServer().getConnections()),
    (connection) =>
      configureOne(database, connection).pipe(
        Effect.catchAll(warnFailure(connection))
      ),
    { concurrency: 'unbounded', discard: true }
  );

/**
 * Core's addon adapter: talks to the in-process addon server directly, the
 * same connections the main process already uses for launch hooks.
 */
export const AddonsFromAddonServer = Layer.effect(
  Addons,
  Effect.map(Database, (database) => {
    return {
      list: configureConnected(database).pipe(
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
          const connection = getAddonServer().getClient(addonId);
          if (!connection) {
            return yield* Effect.fail(
              new AddonError({ message: `Addon ${addonId} is not running` })
            );
          }
          yield* configureOne(database, connection).pipe(
            Effect.catchAll(warnFailure(connection))
          );
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
