import { AddonError, NetworkError } from '@ogi/errors';
import { type ConnectedAddonInfo, Connection } from '@ogi-sdk/client-kit';
import { Effect } from 'effect';
import { getConfigClientOption } from '@/frontend/lib/config/client';

export type AddonInfo = ConnectedAddonInfo;

function initialize(server: Connection) {
  return Effect.all([
    server.on('notification', (notification) =>
      Effect.sync(() => {
        console.log('notification', notification);
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
  ]).pipe(Effect.asVoid);
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

// Module initialization is the runtime boundary for the long-lived SDK client.
export let addonServer = await Effect.runPromise(connectClientSdk());

export function queryConnectedAddons<T = AddonInfo>() {
  return Effect.tryPromise({
    try: () =>
      addonServer.request('query-connected-addons', {
        type: 'addons',
      }),
    catch: (cause) =>
      new AddonError({
        message: `Failed to query connected addons: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((response) =>
      response.statusError
        ? Effect.fail(new AddonError({ message: response.statusError }))
        : Effect.succeed(response.args.addons as T[])
    )
  );
}

let reconnectInFlight: Promise<void> | null = null;

export function reconnectClientSdk() {
  return Effect.tryPromise({
    try: () => {
      if (reconnectInFlight) return reconnectInFlight;

      const reconnect = Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => addonServer.close(),
            catch: (cause) =>
              new NetworkError({
                message: `Failed to close the addon server connection: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
          addonServer = yield* connectClientSdk();
        })
      );
      const sharedReconnect = reconnect.finally(() => {
        if (reconnectInFlight === sharedReconnect) reconnectInFlight = null;
      });
      reconnectInFlight = sharedReconnect;
      return sharedReconnect;
    },
    catch: (cause) =>
      cause instanceof NetworkError
        ? cause
        : new NetworkError({
            message: `Failed to reconnect to the addon server: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
  });
}
