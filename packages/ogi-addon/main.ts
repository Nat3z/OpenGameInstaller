import ws, { WebSocket } from 'ws';
import events from 'node:events';
import { ConfigurationBuilder } from './lib/ConfigurationBuilder';
import { Configuration } from './lib/Configuration';

export type OGIAddonEvent = 'connect' | 'disconnect' | 'configure' | 'response';
export type OGIAddonServerSendEvent = 'authenticate' | 'configure' | 'config-update';

const defaultPort = 7654;

export interface EventListenerTypes {
  connect: (socket: ws) => void;
  disconnect: (reason: string) => void;
  configure: (config: ConfigurationBuilder) => ConfigurationBuilder;
  response: (response: any) => void;
}

export interface WebsocketMessageClient {
  event: OGIAddonEvent;
  id?: string;
  args: any;
}
export interface WebsocketMessageServer {
  event: OGIAddonServerSendEvent;
  id?: string;
  args: any;
}
export interface OGIAddonConfiguration {
  name: string;
  id: string;
  description: string;
  version: string;

  author: string;
  repository: string;
}
export default class OGIAddon {
  public eventEmitter = new events.EventEmitter();
  public addonWSListener: OGIAddonWSListener;
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
  public configuration: Configuration = new Configuration({});

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

      // send a configuration request
      let configBuilder = new ConfigurationBuilder();
      this.eventEmitter.emit('configure', configBuilder);
     
      this.socket.send(JSON.stringify({
        event: 'configure',
        args: configBuilder.build(false) 
      }));
      this.configuration = new Configuration(configBuilder.build(true));
    });

    this.socket.on('error', (error) => {
      if (error.message.includes('Failed to connect')) {
        throw new Error('OGI Addon Server is not running/is unreachable. Please start the server and try again.');
      }
      console.error('An error occurred:', error);
    })

    this.socket.on('close', (code, reason) => {
      if (code === 1008) {
        console.error('Authentication failed:', reason);
        return;
      }
      this.eventEmitter.emit('disconnect', reason);

    });

    this.registerMessageReceiver();
  }

  private registerMessageReceiver() {
    this.socket.on('message', (data: string) => {
      const message: WebsocketMessageServer = JSON.parse(data);
      switch (message.event) {
        case 'config-update':
          console.log(message)
          const result = this.configuration.updateConfig(message.args);
          if (!result[0]) {
            this.respondToMessage(message.id!!, { success: false, error: result[1] });
          }
          else {
            this.respondToMessage(message.id!!, { success: true });
          }
          break 
      }
    });
  }

  public respondToMessage(messageID: string, response: any) {
    this.socket.send(JSON.stringify({
      event: 'response',
      id: messageID,
      args: response
    }));
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