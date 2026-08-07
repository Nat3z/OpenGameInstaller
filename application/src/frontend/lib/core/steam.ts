import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { Effect } from 'effect';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import { createNotification } from '@/frontend/store.svelte';

const logger = createLogger(LOGGER_PREFIXES.frontend);

interface AddToSteamOptions {
  appID: number;
  oldSteamAppId?: number;
  button: HTMLButtonElement;
  onSuccess: (warning?: string) => void;
}

/** Runs the shared Steam-add workflow and always restores the triggering button. */
export function addToSteam({
  appID,
  oldSteamAppId,
  button,
  onSuccess,
}: AddToSteamOptions): Effect.Effect<void, never> {
  return Effect.sync(() => {
    button.disabled = true;
  }).pipe(
    Effect.flatMap(() => electronRpc.app.addToSteam(appID, oldSteamAppId)),
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.status === 'success') {
          onSuccess(result.warning);
          return;
        }

        createNotification({
          id: Math.random().toString(36).substring(7),
          message:
            result.status === 'cancelled' ? result.message : result.error,
          type: result.status === 'cancelled' ? 'info' : 'error',
        });
      })
    ),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        logger.sync.error(error);
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Failed to add game to Steam',
          type: 'error',
        });
      })
    ),
    Effect.ensuring(
      Effect.sync(() => {
        button.disabled = false;
      })
    ),
    Effect.asVoid
  );
}
