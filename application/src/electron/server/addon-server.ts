import { AddonServer } from '@ogi-sdk/addon-server';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { getDatabase } from '@/electron/database/index.js';
import { parseLaunchHookArgs } from '@/electron/lib/single-instance-launch.js';
import { runElectronEffect } from '@/electron/runtime.js';
import { attachAddonDownloadBridge } from '@/electron/server/addon-downloads.js';
import { Prompts } from '@/electron/services/index.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

// `ogi dev` hosts the addon server itself and hands the gui its port and
// secret, so addons the gui starts can still authenticate against it
const devPort: number = Number(process.env.OGI_ADDON_SERVER_PORT);
const devSecret: string | undefined =
  process.env.OGI_ADDON_SERVER_SECRET || undefined;

export const port = Number.isInteger(devPort) && devPort > 0 ? devPort : 7654;

// with --no-server something else (e.g. `ogi dev`) owns the port, so every
// start, including restarts after installs and updates, leaves it alone
const detached: boolean = parseLaunchHookArgs().noAddonServer;

// Read from settings when the server starts, never at import or window
// creation: the database must not be opened before `restoreBackup` has run.
let securityCheckEnabled = true;

/** Whether addons must present the shared secret. Defaults to on. */
export const isSecurityCheckEnabled = (): boolean => securityCheckEnabled;

// The secret is minted once and carried across restarts so the URL the
// window was loaded with keeps matching the listening server.
const createAddonServer = (secret?: string): AddonServer => {
  const instance = new AddonServer({
    port,
    securityCheck: securityCheckEnabled,
    secret,
    // Addon input goes through core Prompts, so any client can answer it.
    askInput: (title, description, config) =>
      Effect.promise(() =>
        runElectronEffect(
          Effect.flatMap(Prompts, (prompts) =>
            prompts.ask({ _tag: 'Input', title, description, config })
          )
        )
      ).pipe(
        Effect.map((answer) => (answer._tag === 'Input' ? answer.values : {}))
      ),
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

// Read synchronously: the addon server's secret is needed before the runtime
// has anything to run, and a failure here must fall back to checks-on.
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
  (server ??= createAddonServer(devSecret));

export let isAddonServerListening = false;
let starting: Effect.Effect<void, unknown> | undefined;

export const startAddonServer = (): Effect.Effect<void, unknown> => {
  if (detached || isAddonServerListening) return Effect.void;
  if (starting) return starting;
  securityCheckEnabled = readSecurityCheck();
  if (!securityCheckEnabled) {
    for (let index = 0; index < 10; index += 1) {
      logger.sync.warn(
        'WARNING Security check is disabled. THIS IS A MAJOR SECURITY RISK.'
      );
    }
  }
  server = createAddonServer(server?.getSecret());
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
