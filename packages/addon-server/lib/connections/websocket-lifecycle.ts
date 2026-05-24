import type { WebSocketLike } from '@ogi-sdk/connect';

/** Bind close/error handlers for both ws-style `.on` and DOM `addEventListener` sockets. */
export function bindWebSocketLifecycle(
  socket: WebSocketLike,
  handlers: { onClose?: () => void; onError?: () => void }
): void {
  const { onClose, onError } = handlers;
  if (socket.on) {
    if (onClose) socket.on('close', onClose);
    if (onError) socket.on('error', onError);
    return;
  }
  if (socket.addEventListener) {
    if (onClose) socket.addEventListener('close', onClose);
    if (onError) socket.addEventListener('error', onError);
  }
}
