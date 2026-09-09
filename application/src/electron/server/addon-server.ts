import { AddonServer } from '@ogi-sdk/addon-server';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { getDatabase } from '@/electron/database/index.js';
import { attachAddonDownloadBridge } from '@/electron/server/addon-downloads.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

export const port = 7654;

// Read from settings when the server starts, never at import or window
// creation: the database must not be opened before `restoreBackup` has run.
let securityCheckEnabled = true;

/** Whether addons must present the shared secret. Defaults to on. */
export const isSecurityCheckEnabled = (): boolean => securityCheckEnabled;

const createAddonServer = (): AddonServer => {
  const instance = new AddonServer({
    port,
    securityCheck: securityCheckEnabled,
  });
  instance.on('disconnect', (reason) => {
    instance.emit('notification', {
      type: 'error',
      message: reason,
      id: `addon-disconnect-${Math.random().toString(36).slice(2)}`,
    });
  });
  attachAddonDownloadBridge(instance);
  return instance;
};

const readSecurityCheck = (): boolean => {
  try {
    return !getDatabase().getSettings().disableSecretCheck;
  } catch (cause) {
    logger.sync.warn(
      '[addon-server] Could not read security settings, keeping checks on',
      cause
    );
    return true;
  }
};

let server: AddonServer | undefined;

/** The addon server; only its secret is needed before startup finishes. */
export const getAddonServer = (): AddonServer =>
  (server ??= createAddonServer());

export let isAddonServerListening = false;
let starting: Effect.Effect<void, unknown> | undefined;

export const startAddonServer = (): Effect.Effect<void, unknown> => {
  if (isAddonServerListening) return Effect.void;
  if (starting) return starting;
  securityCheckEnabled = readSecurityCheck();
  if (!securityCheckEnabled) {
    for (let index = 0; index < 10; index += 1) {
      logger.sync.warn(
        'WARNING Security check is disabled. THIS IS A MAJOR SECURITY RISK.'
      );
    }
  }
  server = createAddonServer();
  starting = server.start().pipe(
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
    ? getAddonServer()
        .stop()
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              isAddonServerListening = false;
            })
          )
        )
    : Effect.void;
