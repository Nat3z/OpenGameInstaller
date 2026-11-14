/**
 * The smallest socket surface the server needs. Fits `ws`, Bun's
 * `ServerWebSocket` (via a tiny adapter), and the in-memory pair used in tests.
 */
export type ServerSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
};

/** Adapts a `ws` WebSocket (what Electron's Node runtime uses). */
export const fromWs = (ws: {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}): ServerSocket => ({
  send: (data) => ws.send(data),
  close: (code, reason) => ws.close(code, reason),
  onMessage: (listener) => ws.on('message', (data) => listener(String(data))),
  onClose: (listener) => ws.on('close', listener),
});
