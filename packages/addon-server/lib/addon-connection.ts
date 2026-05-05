import wsLib from 'ws';
import type {
  OGIAddonConfiguration,
  OGIAddonEvent,
  WebsocketMessageClient,
  WebsocketMessageServer,
} from 'ogi-addon';
import type { ConfigurationFile } from 'ogi-addon/config';
import type { AddonConfig, AddonServer } from './addon';
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
  private pendingResponses: Map<
    string,
    {
      resolve: (value: WebsocketMessageClient) => void;
      reject: (reason?: any) => void;
    }
  > = new Map();
  private messageHandler: ((message: string | Buffer) => void) | null = null;
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
        const data = this.parseClientMessage(message);
        if (!data) return;

        if (this.resolvePendingResponse(data)) return;

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
        this.rejectPendingResponses('Websocket closed')
      );
      this.ws.on('error', () => this.rejectPendingResponses('Websocket error'));
    });
  }

  private parseClientMessage(
    message: string | Buffer
  ): WebsocketMessageClient | undefined {
    try {
      return JSON.parse(message.toString());
    } catch (err) {
      console.error('Failed to parse websocket message:', err);
      this.ws.close(1008, 'Invalid JSON message');
      return undefined;
    }
  }

  private resolvePendingResponse(data: WebsocketMessageClient): boolean {
    if (
      data.event !== 'response' ||
      !data.id ||
      !this.pendingResponses.has(data.id)
    ) {
      return false;
    }

    const pending = this.pendingResponses.get(data.id)!;
    this.pendingResponses.delete(data.id);
    if (!data.args || data.statusError) {
      if (!data.args && !data.statusError) {
        pending.resolve({
          event: 'response',
          args: undefined,
          id: data.id,
        });
      } else {
        pending.reject(data.statusError);
      }
      return true;
    }
    pending.resolve(data);
    return true;
  }

  private rejectPendingResponses(reason: string): void {
    for (const pending of this.pendingResponses.values()) {
      pending.reject(new Error(reason));
    }
    this.pendingResponses.clear();
  }

  public sendEventMessage(
    message: WebsocketMessageServer,
    expectResponse: boolean = true
  ): Promise<WebsocketMessageClient> {
    if (expectResponse) {
      message.id = Math.random().toString(36).substring(7);
    }
    return new Promise((resolve, reject) => {
      // CLOSED state is 3
      if (this.ws.readyState === 3) {
        reject(new Error('Websocket closed'));
        return;
      }

      this.ws.send(JSON.stringify(message), (err: Error | null | undefined) => {
        if (err) {
          reject(err);
          return;
        }
      });

      if (expectResponse && message.id) {
        // Store the pending response handler
        this.pendingResponses.set(message.id, { resolve, reject });
      } else {
        resolve({ event: 'response', args: 'OK' });
      }
    });
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
