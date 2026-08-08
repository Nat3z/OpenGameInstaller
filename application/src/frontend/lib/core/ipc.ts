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

// The addon server may still be starting when the renderer loads.
export let addonServer = await runFrontendEffect(
  connectClientSdk().pipe(
    Effect.tapError((error) => logger.warn('Waiting for addon server:', error)),
    Effect.retry(Schedule.spaced('1 second'))
  )
);

// Keep requests off the closed client while a shared reconnect swaps it out.
let reconnectInFlight: Effect.Effect<void, NetworkError> | null = null;

export function queryConnectedAddons<T = AddonInfo>() {
  return Effect.suspend(() =>
    (reconnectInFlight ?? Effect.void).pipe(
      Effect.mapError(
        (cause) =>
          new AddonError({
            message: `Failed to query connected addons: ${cause.message}`,
          })
      ),
      Effect.zipRight(
        Effect.tryPromise({
          try: () =>
            addonServer.request('query-connected-addons', {
              type: 'addons',
            }),
          catch: (cause) =>
            new AddonError({
              message: `Failed to query connected addons: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        })
      )
    )
  ).pipe(
    Effect.flatMap((response) =>
      response.statusError
        ? Effect.fail(new AddonError({ message: response.statusError }))
        : Effect.succeed(response.args.addons as T[])
    )
  );
}

export function reconnectClientSdk(): Effect.Effect<void, NetworkError> {
  return Effect.suspend(() => {
    if (reconnectInFlight) return reconnectInFlight;

    const reconnect = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => addonServer.close(),
        catch: (cause) =>
          new NetworkError({
            message: `Failed to close the addon server connection: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
      addonServer = yield* connectClientSdk();
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
