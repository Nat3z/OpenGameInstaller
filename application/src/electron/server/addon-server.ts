import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddonServer } from '@ogi-sdk/addon-server';
import { ConfigError, formatError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Schema } from 'effect';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { runElectronSync } from '@/electron/runtime.js';
import { attachAddonDownloadBridge } from '@/electron/server/addon-downloads.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

export const port = 7654;
const DeveloperConfigSchema = Schema.Struct({
  disableSecretCheck: Schema.optional(Schema.Boolean),
});
const developerPath = join(__dirname, 'config/option/developer.json');

const readSecurityConfig = (): Effect.Effect<boolean, ConfigError> => {
  if (!existsSync(developerPath)) return Effect.succeed(true);
  return Effect.gen(function* () {
    const json = yield* Effect.try({
      try: () => JSON.parse(readFileSync(developerPath, 'utf-8')) as unknown,
      catch: (cause) =>
        new ConfigError({
          message: formatError(cause),
          key: 'disableSecretCheck',
        }),
    });
    const config = yield* Schema.decodeUnknown(DeveloperConfigSchema)(
      json
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({ message: String(cause), key: 'disableSecretCheck' })
      )
    );
    return config.disableSecretCheck !== true;
  });
};

export const isSecurityCheckEnabled = runElectronSync(
  readSecurityConfig().pipe(Effect.catchAll(() => Effect.succeed(true)))
);
if (!isSecurityCheckEnabled) {
  for (let index = 0; index < 10; index += 1) {
    logger.sync.warn(
      'WARNING Security check is disabled. THIS IS A MAJOR SECURITY RISK.'
    );
  }
}

const createAddonServer = (): AddonServer => {
  const server = new AddonServer({
    port,
    securityCheck: isSecurityCheckEnabled,
  });
  server.on('disconnect', (reason) => {
    server.emit('notification', {
      type: 'error',
      message: reason,
      id: `addon-disconnect-${Math.random().toString(36).slice(2)}`,
    });
  });
  attachAddonDownloadBridge(server);
  return server;
};

export let addonServer = createAddonServer();
export let isAddonServerListening = false;
let starting: Effect.Effect<void, unknown> | undefined;

export const startAddonServer = (): Effect.Effect<void, unknown> => {
  if (isAddonServerListening) return Effect.void;
  if (starting) return starting;
  addonServer = createAddonServer();
  starting = addonServer.start().pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        isAddonServerListening = true;
      })
    ),
    Effect.ensuring(
      Effect.sync(() => {
        starting = undefined;
      })
    )
  );
  return starting;
};

export const stopAddonServer = (): Effect.Effect<void, unknown> =>
  isAddonServerListening
    ? addonServer.stop().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            isAddonServerListening = false;
          })
        )
      )
    : Effect.void;
