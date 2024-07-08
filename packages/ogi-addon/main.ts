import ws, { WebSocket } from 'ws';
import events from 'node:events';

export type OGIAddonEvent = 'connect' | 'disconnect' | 'configure';
export type OGIAddonServerSendEvent = 'authenticate' | 'configure';

const defaultPort = 7654;

export interface EventListenerTypes {
  connect: (socket: ws) => void;
  disconnect: (reason: string) => void;
  configure: (config: any) => Promise<void>;
}

export interface WebsocketMessage {
  event: OGIAddonEvent;
  args: any;
}
export interface WebsocketMessageServer {
  event: OGIAddonServerSendEvent;
  args: any;
}
export interface OGIAddonConfiguration {
  name: string;
  description: string;
  version: string;

  author: string;
  repository: string;
}
export default class OGIAddon {
  private eventEmitter = new events.EventEmitter();
  private addonWSListener: OGIAddonWSListener;
  public configuration: OGIAddonConfiguration;
  constructor(configuration: OGIAddonConfiguration) {
    this.configuration = configuration;
    this.addonWSListener = new OGIAddonWSListener(this, this.eventEmitter);
  }
  
  public on<T extends OGIAddonEvent>(event: T, listener: EventListenerTypes[T]) {
    this.eventEmitter.on(event, listener);
  }

  public emit<T extends OGIAddonEvent>(event: T, ...args: Parameters<EventListenerTypes[T]>) {
    this.eventEmitter.emit(event, ...args);
  }
}

class OGIAddonWSListener {
  private socket: WebSocket;
  public eventEmitter: events.EventEmitter;
  public addon: OGIAddon;

  constructor(ogiAddon: OGIAddon, eventEmitter: events.EventEmitter) {
    this.addon = ogiAddon;
    this.eventEmitter = eventEmitter;
    this.socket = new ws('ws://localhost:' + defaultPort);
    this.socket.on('open', () => {
      console.log('Connected to OGI Addon Server');

      // Authenticate with OGI Addon Server
      this.socket.send(JSON.stringify({
        event: 'authenticate',
        args: {
          ...this.addon.configuration
        }
      }));

    });
  }

  public send(event: OGIAddonEvent, ...args: Parameters<EventListenerTypes[OGIAddonEvent]>) {
    this.socket.send(JSON.stringify({
      event,
      args
    }));
  }

  public receive(event: OGIAddonEvent, listener: EventListenerTypes[OGIAddonEvent]) {
    this.socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.event === event) {
        listener(message.args);
      }
    });
  }

  public close() {
    this.socket.close();
  }
}