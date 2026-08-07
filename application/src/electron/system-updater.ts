import { formatError, UpdateError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { Effect } from 'effect';
import { getEffectiveOnlineState } from '@/electron/lib/online.js';
import { downloadLatestUmu } from '@/electron/startup.js';
import {
  checkIfInstallerUpdateAvailable,
  type UpdaterCallbacks,
} from '@/electron/updater.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

export type SystemUpdateResult = {
  id: string;
  success: boolean;
  updated?: boolean;
  /** Stop startup and close the app after this updater finishes. */
  shutdownRequired?: boolean;
  error?: string;
};

export function requiresSystemUpdateShutdown(
  results: readonly SystemUpdateResult[]
): boolean {
  return results.some((result) => result.shutdownRequired === true);
}

export interface SystemUpdater {
  id: string;
  label: string;
  shouldRun(): Effect.Effect<boolean, UpdateError>;
  update(
    callbacks: UpdaterCallbacks
  ): Effect.Effect<SystemUpdateResult, UpdateError>;
}

export class SystemUpdateManager {
  private updaters: SystemUpdater[] = [];

  constructor(updaters: SystemUpdater[] = []) {
    this.updaters = [...updaters];
  }

  register(updater: SystemUpdater): void {
    this.updaters.push(updater);
  }

  updateOnlineSystem(
    callbacks: UpdaterCallbacks
  ): Effect.Effect<SystemUpdateResult[]> {
    return Effect.gen(this, function* () {
      const onlineState = getEffectiveOnlineState();
      if (!onlineState.effectiveOnline) {
        logger.sync.info(
          `[system-updater] Offline mode enabled (${onlineState.reason}), skipping updates`
        );
        return [];
      }

      const results: SystemUpdateResult[] = [];
      for (const updater of this.updaters) {
        const shouldRun = yield* updater.shouldRun().pipe(
          Effect.catchAll((error) => {
            logger.sync.error(
              `[system-updater] Could not determine whether ${updater.id} should run:`,
              error
            );
            results.push({
              id: updater.id,
              success: false,
              error: error.message,
            });
            return Effect.succeed(false);
          })
        );
        if (!shouldRun) {
          logger.sync.info(`[system-updater] Skipping ${updater.id}`);
          continue;
        }

        callbacks.onStatus(`Checking ${updater.label} updates...`);
        const result = yield* updater.update(callbacks).pipe(
          Effect.catchAll((error) => {
            logger.sync.error(`[system-updater] ${updater.id} failed:`, error);
            return Effect.succeed<SystemUpdateResult>({
              id: updater.id,
              success: false,
              error: error.message,
            });
          })
        );
        results.push(result);
        if (result.shutdownRequired) {
          break;
        }
      }

      return results;
    });
  }
}

export class SetupAppImageUpdater implements SystemUpdater {
  id = 'setup-appimage';
  label = 'installer';

  shouldRun(): Effect.Effect<boolean> {
    return Effect.succeed(true);
  }

  update(
    callbacks: UpdaterCallbacks
  ): Effect.Effect<SystemUpdateResult, UpdateError> {
    return Effect.tryPromise({
      try: () => checkIfInstallerUpdateAvailable(callbacks),
      catch: (cause) =>
        new UpdateError({
          message: `Failed to check installer updates: ${formatError(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.map((result) => ({
        id: this.id,
        success: result.success,
        updated: result.updated,
        shutdownRequired: result.updated,
        error: result.error,
      }))
    );
  }
}

export class UmuLauncherUpdater implements SystemUpdater {
  id = 'umu-launcher';
  label = 'UMU launcher';

  shouldRun(): Effect.Effect<boolean> {
    return Effect.succeed(process.platform === 'linux');
  }

  update(): Effect.Effect<SystemUpdateResult, UpdateError> {
    return Effect.tryPromise({
      try: () => downloadLatestUmu(),
      catch: (cause) =>
        new UpdateError({
          message: `Failed to update UMU launcher: ${formatError(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.map((result) => ({
        id: this.id,
        success: result.success,
        updated: result.updated,
        error: result.error,
      }))
    );
  }
}

export function createDefaultSystemUpdateManager(): SystemUpdateManager {
  return new SystemUpdateManager([
    new SetupAppImageUpdater(),
    new UmuLauncherUpdater(),
  ]);
}
