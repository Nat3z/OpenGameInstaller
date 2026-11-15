import { OGIClient } from '@ogi-sdk/client-kit';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Schedule } from 'effect';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';

const logger = createLogger(LOGGER_PREFIXES.frontend);

/**
 * The renderer's connection to core: the same `OGIClient` any other
 * frontend (a Deck UI, a script) uses. Everything download-related goes
 * through it; there is no download logic left in the renderer.
 */
let client: Promise<OGIClient> | undefined;

const connect = (): Promise<OGIClient> =>
  runFrontendEffect(
    electronRpc.app.clientConnection().pipe(
      // The server starts after the addon runtime; wait for it.
      Effect.flatMap((info) =>
        info ? Effect.succeed(info) : Effect.fail('not ready' as const)
      ),
      Effect.retry(Schedule.spaced('500 millis')),
      Effect.flatMap(({ url, token }) =>
        Effect.promise(() => OGIClient.connect({ url, token }))
      )
    )
  );

const connected = new Set<(client: OGIClient) => void>();

/**
 * Runs `use` on the current client and on every one after a reconnect, so
 * watches survive the connection dropping (a restarted client server, say).
 */
export const onConnected = (use: (client: OGIClient) => void): void => {
  connected.add(use);
  void ogi().then(use, () => {});
};

/** The shared client, connected on first use and again after a drop. */
export const ogi = (): Promise<OGIClient> => {
  if (client) return client;
  const attempt = connect().then((connectedClient) => {
    // Gone: forget it, so the next call (or the reconnect below) is fresh.
    void connectedClient.disconnected.then((reason) => {
      if (client !== attempt) return;
      client = undefined;
      logger.sync.warn('Lost the core protocol connection:', reason);
      void ogi().then(
        (next) => {
          for (const use of connected) use(next);
        },
        () => {}
      );
    });
    return connectedClient;
  });
  client = attempt.catch((error: unknown) => {
    client = undefined;
    logger.sync.error('Could not connect to the core protocol:', error);
    throw error;
  });
  return client;
};
