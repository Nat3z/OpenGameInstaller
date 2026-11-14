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

/** The shared client, connected on first use. */
export const ogi = (): Promise<OGIClient> => {
  client ??= connect().catch((error: unknown) => {
    client = undefined;
    logger.sync.error('Could not connect to the core protocol:', error);
    throw error;
  });
  return client;
};
