import { type ConnectedAddonInfo, Connection } from '@ogi-sdk/client-kit';
import { Effect } from 'effect';
import { getConfigClientOption } from '@/frontend/lib/config/client';

export type AddonInfo = ConnectedAddonInfo;

export async function connectClientSdk(): Promise<Connection> {
  const developerConfig = getConfigClientOption('developer') as { clientSdkUrl?: string } | null;
  const server = await Effect.runPromise(Connection.make({
    url: developerConfig?.clientSdkUrl ?? 'ws://127.0.0.1:7654',
  }));
  initialize(server);
  return server;
}

export let addonServer = await connectClientSdk();

export async function queryConnectedAddons<T = AddonInfo>(): Promise<T[]> {
  const response = await Effect.runPromise(addonServer.request('query-connected-addons', { type: 'addons' }));
  if (response.statusError) throw new Error(response.statusError);
  return response.args.addons as T[];
}

let reconnectInFlight: Promise<void> | null = null;
export async function reconnectClientSdk(): Promise<void> {
  if (reconnectInFlight) return reconnectInFlight;
  reconnectInFlight = (async () => {
    await Effect.runPromise(addonServer.close());
    addonServer = await connectClientSdk();
  })().finally(() => { reconnectInFlight = null; });
  return reconnectInFlight;
}

function initialize(server: Connection): void {
  Effect.runFork(server.on('notification', (notification) => Effect.sync(() => {
    console.log('notification', notification);
    document.dispatchEvent(new CustomEvent('new-notification', { detail: notification }));
  })));
  Effect.runFork(server.on('input-asked', ({ config, name, description, reply }) => Effect.sync(() => {
    document.dispatchEvent(new CustomEvent('input-asked', {
      detail: { id: Math.random().toString(36).substring(7), config, name, description, reply },
    }));
  })));
}
