import { Effect } from 'effect';
import { ElectronRpcError } from '@/lib/electron-rpc.js';

type ElectronRpcHandler = (event: undefined, ...args: any[]) => unknown;

type RegisteredHandler = {
  readonly handler: ElectronRpcHandler;
  readonly once: boolean;
};

const handlers = new Map<string, RegisteredHandler>();

function registerHandler(
  channel: string,
  handler: ElectronRpcHandler,
  once: boolean
): void {
  if (handlers.has(channel)) {
    throw new Error(`Attempted to register a second handler for '${channel}'`);
  }
  handlers.set(channel, { handler, once });
}

export const electronIpcMain = {
  handle: (channel: string, handler: ElectronRpcHandler): void => {
    registerHandler(channel, handler, false);
  },
  handleOnce: (channel: string, handler: ElectronRpcHandler): void => {
    registerHandler(channel, handler, true);
  },
  removeHandler: (channel: string): void => {
    handlers.delete(channel);
  },
};

export function invokeElectronRpcHandler(
  channel: string,
  args: ReadonlyArray<unknown>
): Effect.Effect<unknown, ElectronRpcError> {
  return Effect.tryPromise({
    try: async () => {
      const registered = handlers.get(channel);
      if (!registered) {
        throw new Error(`No Electron RPC handler registered for '${channel}'`);
      }
      if (registered.once) handlers.delete(channel);
      return await registered.handler(undefined, ...args);
    },
    catch: (cause) =>
      new ElectronRpcError({
        channel,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}
