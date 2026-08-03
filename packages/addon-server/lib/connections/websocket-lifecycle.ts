import { NetworkError } from '@ogi/errors';
import type { WebSocketLike } from '@ogi-sdk/connect';
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
          socket.off?.('close', onClose ?? (() => undefined));
          socket.off?.('error', onError ?? (() => undefined));
        };
      }
      if (socket.addEventListener) {
        if (onClose) socket.addEventListener('close', onClose);
        if (onError) socket.addEventListener('error', onError);
        return () => {
          socket.removeEventListener?.('close', onClose ?? (() => undefined));
          socket.removeEventListener?.('error', onError ?? (() => undefined));
        };
      }
      throw new TypeError('Unsupported websocket implementation');
    },
    catch: (cause) =>
      new NetworkError({
        message: `Unable to bind websocket lifecycle: ${String(cause)}`,
      }),
  });
