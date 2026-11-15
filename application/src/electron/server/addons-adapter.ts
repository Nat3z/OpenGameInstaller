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
// Per connection, not per addon id: a reconnected addon is a new connection
// and needs its settings again even if a replay to it failed.
const configured = new WeakSet<AddonConnection>();

const configureOne = (
  database: Context.Tag.Service<Database>,
  connection: AddonConnection
) =>
  Effect.gen(function* () {
    const server = getAddonServer();
    const id = connection.addonInfo?.id;
    const template = connection.configTemplate;
    if (!id || !template || configured.has(connection)) return;
    // The server's reconnect replay already got an answer: nothing to send.
    if (connection.eventsAvailable.length > 0) {
      configured.add(connection);
      return;
    }
    let config = yield* database.addonConfig.get(id);
    if (!config) {
      config = buildDefaultConfig(template);
      yield* database.addonConfig.set(id, config);
    }
    // Bounded: an addon that never answers is skipped (and retried on the
    // next request), not waited on by every call to the others.
    const reply = yield* connection.events
      .configUpdate(config as unknown as ConfigurationFile)
      .pipe(
        Effect.timeoutFail({
          duration: '10 seconds',
          onTimeout: () => new Error(`${id} did not answer its config`),
        })
      );
    // Addons reject settings as `success: false`; never replay those.
    const accepted =
      !reply.statusError &&
      (reply.args as { success?: boolean } | undefined)?.success !== false;
    if (accepted) {
      configured.add(connection);
      server.rememberConfig(id, config as unknown as ConfigurationFile);
    } else
      yield* logger.warn(
        `[addons] ${id} rejected its settings`,
        reply.statusError ?? (reply.args as { error?: string })?.error
      );
  });

/** How long each call may wait for its reply; searches can scrape slowly. */
const REPLY_TIMEOUT = {
  search: '60 seconds',
  'game-details': '30 seconds',
  catalog: '30 seconds',
} as const;

const warnFailure = (connection: AddonConnection) => (error: unknown) =>
  logger.warn(
    `[addons] Could not configure ${connection.addonInfo?.id}`,
    error
  );

const describe = (connection: AddonConnection) => {
  const info = connection.addonInfo;
  return info
    ? {
        id: info.id,
        name: info.name,
        version: info.version,
        description: info.description,
        storefronts: info.storefronts ?? [],
        events: connection.eventsAvailable.map(String),
      }
    : null;
};

/** Configures one connection, bounded; a failure is logged, not raised. */
const ready = (
  database: Context.Tag.Service<Database>,
  connection: AddonConnection
) =>
  configureOne(database, connection).pipe(
    Effect.catchAll(warnFailure(connection))
  );

/**
 * Core's addon adapter: talks to the in-process addon server directly, the
 * same connections the main process already uses for launch hooks.
 */
export const AddonsFromAddonServer = Layer.effect(
  Addons,
  Effect.map(Database, (database) => {
    return {
      // Connected addons as they are now; listing never waits on a config.
      // Each one is made ready in the background for the next request.
      list: Effect.suspend(() => {
        const connections = Array.from(getAddonServer().getConnections());
        return Effect.forkDaemon(
          Effect.forEach(connections, (c) => ready(database, c), {
            concurrency: 'unbounded',
            discard: true,
          })
        ).pipe(
          Effect.as(
            connections.flatMap((connection) => {
              const addon = describe(connection);
              return addon ? [addon] : [];
            })
          )
        );
      }),
      // The one addon a call needs, configured first (bounded).
      describe: (addonId) =>
        Effect.suspend(() => {
          const connection = getAddonServer().getClient(addonId);
          if (!connection) return Effect.succeed(null);
          // Read after `ready`: configuring is what announces the events.
          return ready(database, connection).pipe(
            Effect.map(() => describe(connection))
          );
        }),
      call: (addonId, event, args) =>
        Effect.gen(function* () {
          const connection = getAddonServer().getClient(addonId);
          if (!connection) {
            return yield* Effect.fail(
              new AddonError({ message: `Addon ${addonId} is not running` })
            );
          }
          yield* ready(database, connection);
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
            ),
            // An addon that stops answering (socket still open) must not hang
            // the call, or the client waiting on it, forever.
            Effect.timeoutFail({
              duration: REPLY_TIMEOUT[event],
              onTimeout: () =>
                new AddonError({
                  message: `${connection.addonInfo?.name ?? addonId} did not answer ${event}`,
                  addonName: connection.addonInfo?.name,
                }),
            })
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
