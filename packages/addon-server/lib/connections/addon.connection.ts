import { EventResponseSocket } from '@ogi-sdk/connect';
import type {
  AddonServerToClientEventArgs,
  OGIAddonConfiguration,
  OGIAddonSDKEventListener,
  AddonClientToServerWebsocketMessage,
  AddonServerToClientWebsocketMessage,
  ConfigurationFile,
} from '@ogi-sdk/connect';
import type { AddonConfig, AddonServer } from '../server';
import {
  buildEventMessage,
  eventAliases,
  type SendEventProxy,
} from '../_generated/event-proxy';
import { createClientMessageHandlers } from '../handlers/client-message-handlers';
import type { ClientMessageHandlers } from '../handlers/types';

interface AddonWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (rawMessage: unknown) => void): unknown;
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
  readyState: number;
}

export class AddonConnection {
  public addonInfo: OGIAddonConfiguration | undefined;
  public ws: AddonWebSocket;
  public configTemplate: ConfigurationFile | undefined;
  public filePath: string | undefined;
  public addonLink: string | undefined;
  public eventsAvailable: OGIAddonSDKEventListener[] = [];
  public readonly events: SendEventProxy;
  private transport: EventResponseSocket<
    AddonClientToServerWebsocketMessage,
    AddonServerToClientWebsocketMessage
  >;
  private config: AddonConfig;
  private server: AddonServer;
  private clientEventHandlers: ClientMessageHandlers;

  constructor(
    ws: AddonWebSocket,
    config: AddonConfig,
    server: AddonServer
  ) {
    this.ws = ws;
    this.config = config;
    this.server = server;
    this.events = this.createSendEventProxy(true);
    this.transport = new EventResponseSocket(this.ws, {
      onInvalidMessage: () => {
        console.error('Failed to parse websocket message');
        this.ws.close(1008, 'Invalid JSON message');
      },
    });
    this.clientEventHandlers = createClientMessageHandlers();
  }

  public configure(config: ConfigurationFile): void {
    this.events.noResponse.configUpdate(config);
  }

  public async setupWebsocket(): Promise<boolean> {
    return new Promise((resolve, _) => {
      const authenticationTimeout = setTimeout(() => {
        this.ws.close(1008, 'Authentication timeout');
        console.error('Client kicked due to authentication timeout');
        resolve(false);
      }, 1000);

      Object.entries(this.clientEventHandlers).forEach(([event, handler]) => {
        this.transport.on(
          event as AddonClientToServerWebsocketMessage['event'],
          async (data) => {
            await handler(
              {
                connection: this,
                config: this.config,
                server: this.server,
                authenticationTimeout,
                resolveAuthentication: resolve,
              },
              data as AddonClientToServerWebsocketMessage
            );
          }
        );
      });

      this.ws.on('close', () =>
        this.transport.rejectPendingResponses('Websocket closed')
      );
      this.ws.on('error', () =>
        this.transport.rejectPendingResponses('Websocket error')
      );
    });
  }

  public sendEventMessage(
    message: AddonServerToClientWebsocketMessage,
    expectResponse: boolean = true
  ): Promise<AddonClientToServerWebsocketMessage> {
    return this.transport.send(message, { expectResponse });
  }

  private createSendEventProxy(defaultExpectResponse: boolean): SendEventProxy {
    return new Proxy(
      {},
      {
        get: (_, property) => {
          if (property === 'noResponse') {
            return this.createSendEventProxy(false);
          }

          if (typeof property !== 'string') {
            return undefined;
          }

          const event = eventAliases[property];
          if (!event) {
            return undefined;
          }

          return (...args: AddonServerToClientEventArgs[typeof event]) => {
            return this.sendEventMessage(
              buildEventMessage(event, args),
              event === 'response' ? false : defaultExpectResponse
            );
          };
        },
      }
    ) as SendEventProxy;
  }
}
