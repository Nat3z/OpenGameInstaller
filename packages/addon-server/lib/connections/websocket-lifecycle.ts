import type { WebSocketLike } from '@ogi-sdk/connect';
import { NetworkError } from '@ogi/errors';
import { Effect } from 'effect';

/** Installs lifecycle callbacks and runs their Effects at the websocket boundary. */
export const bindWebSocketLifecycle = (
  socket: WebSocketLike,
  handlers: {
    readonly onClose?: () => Effect.Effect<void>;
    readonly onError?: () => Effect.Effect<void>;
  }
): Effect.Effect<void, NetworkError> =>
  Effect.try({
    try: () => {
      const onClose = handlers.onClose
        ? () => Effect.runFork(handlers.onClose!())
        : undefined;
      const onError = handlers.onError
        ? () => Effect.runFork(handlers.onError!())
        : undefined;

      if (socket.on) {
        if (onClose) socket.on('close', onClose);
        if (onError) socket.on('error', onError);
        return;
      }
      if (socket.addEventListener) {
        if (onClose) socket.addEventListener('close', onClose);
        if (onError) socket.addEventListener('error', onError);
        return;
      }
      throw new TypeError('Unsupported websocket implementation');
    },
    catch: (cause) =>
      new NetworkError({
        message: `Unable to bind websocket lifecycle: ${String(cause)}`,
      }),
  });
