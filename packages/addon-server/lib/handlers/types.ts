import type {
  AddonClientToServerEventName,
  AddonClientToServerWebsocketMessage,
} from '@ogi-sdk/connect';
import type { Effect } from 'effect';
import type { AddonConnection } from '../connections/addon.connection';
import type { AddonConfig, AddonServer } from '../server';

export type HandlerContext = {
  connection: AddonConnection;
  config: AddonConfig;
  server: AddonServer;
  resolveAuthentication: (authenticated: boolean) => Effect.Effect<void>;
};

export type ClientMessageHandler = (
  context: HandlerContext,
  message: AddonClientToServerWebsocketMessage
) => Effect.Effect<void, unknown>;

export type ClientMessageHandlers = Partial<
  Record<AddonClientToServerEventName, ClientMessageHandler>
>;

export type { AddonServerToClientEventArgs } from '@ogi-sdk/connect';
