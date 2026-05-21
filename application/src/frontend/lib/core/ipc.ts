import { Connection } from '@ogi-sdk/client-kit';
import { getConfigClientOption } from '@/frontend/lib/config/client';

export let addonServer = connectClientSdk();

export type AddonInfo = {
  id: string;
  name: string;
  eventsAvailable: string[];
  storefronts?: unknown;
  configTemplate?: unknown;
  [key: string]: unknown;
};

export async function queryConnectedAddons<T = AddonInfo>() {
  const response = await addonServer.request('query-connected-addons', {
    type: 'addons',
  });
  if (response.statusError) throw new Error(response.statusError);
  return response.args.addons as T[];
}
export function reconnectClientSdk(): void {
  addonServer.close();
  addonServer = connectClientSdk();
}
export function connectClientSdk(): Connection {
  const developerConfig = getConfigClientOption('developer') as
    | { clientSdkUrl?: string }
    | null;
  let server = new Connection({
    url: developerConfig?.clientSdkUrl ?? 'ws://127.0.0.1:7654',
  });
  initialize(server);
  return server;
}

function initialize(server: Connection) {
  server.on('notification', (notification) => {
    document.dispatchEvent(
      new CustomEvent('new-notification', { detail: notification })
    );
  });

  server.on('input-asked', ({ config, name, description, reply }) => {
    document.dispatchEvent(
      new CustomEvent('input-asked', {
        detail: {
          id: Math.random().toString(36).substring(7),
          config,
          name,
          description,
          reply,
        },
      })
    );
  });
}
