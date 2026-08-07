import type { WebSocketLike } from '@ogi-sdk/connect';
import { NetworkError } from '@ogi-sdk/errors';
import { Effect } from 'effect';

type Supervisor = (effect: Effect.Effect<void>) => void;

/** Installs lifecycle callbacks at the websocket compatibility boundary. */
export const bindWebSocketLifecycle = (
  socket: WebSocketLike,
  supervise: Supervisor,
  handlers: {
    readonly onClose?: () => Effect.Effect<void>;
    readonly onError?: () => Effect.Effect<void>;
  }
): Effect.Effect<() => void, NetworkError> =>
  Effect.try({
    try: () => {
      const onClose = handlers.onClose
        ? () => supervise(handlers.onClose!())
        : undefined;
      const onError = handlers.onError
        ? () => supervise(handlers.onError!())
        : undefined;

      if (socket.on) {
        if (onClose) socket.on('close', onClose);
        if (onError) socket.on('error', onError);
        return () => {
          if (onClose) socket.off?.('close', onClose);
          if (onError) socket.off?.('error', onError);
        };
      }
      if (socket.addEventListener) {
        if (onClose) socket.addEventListener('close', onClose);
        if (onError) socket.addEventListener('error', onError);
        return () => {
          if (onClose) socket.removeEventListener?.('close', onClose);
          if (onError) socket.removeEventListener?.('error', onError);
        };
      }
      throw new TypeError('Unsupported websocket implementation');
    },
    catch: (cause) =>
      new NetworkError({
        message: `Unable to bind websocket lifecycle: ${String(cause)}`,
      }),
  });
