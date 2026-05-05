import type {
  OGIAddonClientSentEvent,
  WebsocketMessageClient,
} from 'ogi-addon';
import type { AddonConnection } from '../addon-connection';
import type { AddonConfig, AddonServer } from '../addon';

export type HandlerContext = {
  connection: AddonConnection;
  config: AddonConfig;
  server: AddonServer;
  authenticationTimeout: Timer;
  resolveAuthentication: (authenticated: boolean) => void;
};

export type ClientMessageHandler = (
  context: HandlerContext,
  message: WebsocketMessageClient
) => Promise<void> | void;

export type ClientMessageHandlers = Partial<
  Record<OGIAddonClientSentEvent, ClientMessageHandler>
>;
