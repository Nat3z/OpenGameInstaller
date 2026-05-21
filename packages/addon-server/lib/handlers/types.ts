import type {
  AddonClientToServerEventName,
  AddonClientToServerWebsocketMessage,
} from '@ogi-sdk/connect';
import type { AddonConnection } from '../connections/addon.connection';
import type { AddonConfig, AddonServer } from '../server';

export type HandlerContext = {
  connection: AddonConnection;
  config: AddonConfig;
  server: AddonServer;
  authenticationTimeout: Timer;
  resolveAuthentication: (authenticated: boolean) => void;
};

export type ClientMessageHandler = (
  context: HandlerContext,
  message: AddonClientToServerWebsocketMessage
) => Promise<void> | void;

export type ClientMessageHandlers = Partial<
  Record<AddonClientToServerEventName, ClientMessageHandler>
>;

export type { AddonServerToClientEventArgs } from '@ogi-sdk/connect';
