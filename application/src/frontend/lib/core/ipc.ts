import { type ConnectedAddonInfo, Connection } from '@ogi-sdk/client-kit';
import { AddonError, NetworkError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Schedule } from 'effect';
import { getConfigClientOption } from '@/frontend/lib/config/client';
import {
  runFrontendEffect,
  runFrontendSync,
} from '@/frontend/lib/core/runtime';

const logger = createLogger(LOGGER_PREFIXES.frontend);

export type AddonInfo = ConnectedAddonInfo;

function initialize(server: Connection): Effect.Effect<void, NetworkError> {
  return Effect.tryPromise({
    try: () =>
      Promise.all([
        server.on('notification', (notification) =>
          Effect.sync(() => {
            logger.sync.info('notification', notification);
            document.dispatchEvent(
              new CustomEvent('new-notification', { detail: notification })
            );
          })
        ),
        server.on('input-asked', ({ config, name, description, reply }) =>
          Effect.sync(() => {
            document.dispatchEvent(
              new CustomEvent('input-asked', {
                detail: {
                  id: Math.random().toString(36).substring(7),
                  config,
                  name,
                  description,
                  reply,
                },
              })
            );
          })
        ),
      ]).then(() => undefined),
    catch: (cause) =>
      new NetworkError({
        message: `Failed to initialize the addon server connection: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

export function connectClientSdk() {
  const developerConfig = getConfigClientOption('developer') as {
    clientSdkUrl?: string;
  } | null;
  const url = developerConfig?.clientSdkUrl ?? 'ws://127.0.0.1:7654';

  return Effect.tryPromise({
    try: () => Connection.make({ url }),
    catch: (cause) =>
      new NetworkError({
        message: `Failed to connect to the addon server: ${cause instanceof Error ? cause.message : String(cause)}`,
        url,
      }),
  }).pipe(Effect.tap(initialize));
}

let addonServer: Connection | null = null;
let connectionInFlight: Effect.Effect<Connection, NetworkError> | null = null;

export function getAddonServer(): Effect.Effect<Connection, NetworkError> {
  return Effect.suspend(() => {
    if (addonServer) return Effect.succeed(addonServer);
    if (connectionInFlight) return connectionInFlight;

    const connect = connectClientSdk().pipe(
      Effect.tapError((error) =>
        logger.warn('Waiting for addon server:', error)
      ),
      Effect.retry(Schedule.spaced('1 second')),
      Effect.tap((connection) =>
        Effect.sync(() => {
          addonServer = connection;
        })
      )
    );
    const sharedConnection = runFrontendSync(Effect.cached(connect)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (connectionInFlight === sharedConnection)
            connectionInFlight = null;
        })
      )
    );
    connectionInFlight = sharedConnection;
    return sharedConnection;
  });
}

export function getAddonServerPromise(): Promise<Connection> {
  return runFrontendEffect(getAddonServer());
}

// Share reconnects so concurrent stale-socket recoveries never race.
let reconnectInFlight: Effect.Effect<void, NetworkError> | null = null;

function requestConnectedAddons<T>() {
  return Effect.gen(function* () {
    const connection = yield* getAddonServer();
    const response = yield* Effect.tryPromise({
      try: () =>
        connection.request('query-connected-addons', {
          type: 'addons',
        }),
      catch: (cause) =>
        new NetworkError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    return response.statusError
      ? yield* Effect.fail(new AddonError({ message: response.statusError }))
      : (response.args.addons as T[]);
  });
}

export function queryConnectedAddons<T = AddonInfo>() {
  return Effect.suspend(() =>
    (reconnectInFlight ?? Effect.void).pipe(
      Effect.zipRight(requestConnectedAddons<T>()),
      Effect.catchTag('NetworkError', () =>
        reconnectClientSdk().pipe(Effect.zipRight(requestConnectedAddons<T>()))
      ),
      Effect.mapError((cause) =>
        cause._tag === 'AddonError'
          ? cause
          : new AddonError({
              message: `Failed to query connected addons: ${cause.message}`,
            })
      )
    )
  );
}

export function reconnectClientSdk(): Effect.Effect<void, NetworkError> {
  return Effect.suspend(() => {
    if (reconnectInFlight) return reconnectInFlight;

    const reconnect = Effect.gen(function* () {
      const staleConnection = addonServer;
      addonServer = null;
      if (staleConnection) {
        yield* Effect.tryPromise({
          try: () => staleConnection.close(),
          catch: (cause) =>
            new NetworkError({
              message: `Failed to close the addon server connection: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
      }
      // A stale query can detect the backend between its stop and start phases.
      addonServer = yield* connectClientSdk().pipe(
        Effect.retry(
          Schedule.intersect(Schedule.spaced('250 millis'), Schedule.recurs(4))
        )
      );
    });
    const sharedReconnect = runFrontendSync(Effect.cached(reconnect)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (reconnectInFlight === sharedReconnect) reconnectInFlight = null;
        })
      )
    );
    reconnectInFlight = sharedReconnect;
    return sharedReconnect;
  });
}
