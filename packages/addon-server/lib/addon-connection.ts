import wsLib from 'ws';
import { EventResponseSocket } from '@ogi-sdk/connect';
import type {
  OGIAddonConfiguration,
  OGIAddonEvent,
  WebsocketMessageClient,
  WebsocketMessageServer,
} from 'ogi-addon';
import type { ConfigurationFile } from 'ogi-addon/config';
import type { AddonConfig, AddonServer } from './server';
import {
  buildEventMessage,
  eventAliases,
  type SendEventProxy,
  type ServerEventArgs,
} from './_generated/event-proxy';
import { createClientMessageHandlers } from './handlers/client-message-handlers';
import type { ClientMessageHandlers } from './handlers/types';

export class AddonConnection {
  public addonInfo: OGIAddonConfiguration | undefined;
  public ws: InstanceType<typeof wsLib>;
  public configTemplate: ConfigurationFile | undefined;
  public filePath: string | undefined;
  public addonLink: string | undefined;
  public eventsAvailable: OGIAddonEvent[] = [];
  public readonly events: SendEventProxy;
  private messageHandler: ((message: string | Buffer) => void) | null = null;
  private transport: EventResponseSocket<
    WebsocketMessageClient,
    WebsocketMessageServer
  >;
  private config: AddonConfig;
  private server: AddonServer;
  private clientEventHandlers: ClientMessageHandlers;

  constructor(
    ws: InstanceType<typeof wsLib>,
    config: AddonConfig,
    server: AddonServer
  ) {
    this.ws = ws;
    this.config = config;
    this.server = server;
    this.events = this.createSendEventProxy(true);
    this.transport = new EventResponseSocket(this.ws);
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

      this.messageHandler = async (message: string | Buffer) => {
        const data = this.transport.parseMessage(message);
        if (!data) {
          console.error('Failed to parse websocket message');
          this.ws.close(1008, 'Invalid JSON message');
          return;
        }

        if (this.transport.resolveIncomingResponse(data)) return;

        const handler = this.clientEventHandlers[data.event];
        if (!handler) return;

        await handler(
          {
            connection: this,
            config: this.config,
            server: this.server,
            authenticationTimeout,
            resolveAuthentication: resolve,
          },
          data
        );
      };

      this.ws.on('message', this.messageHandler);

      this.ws.on('close', () =>
        this.transport.rejectPendingResponses('Websocket closed')
      );
      this.ws.on('error', () =>
        this.transport.rejectPendingResponses('Websocket error')
      );
    });
  }

  public sendEventMessage(
    message: WebsocketMessageServer,
    expectResponse: boolean = true
  ): Promise<WebsocketMessageClient> {
    return this.transport.send(message, expectResponse);
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

          return (...args: ServerEventArgs[typeof event]) => {
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
