import ws, { WebSocket } from 'ws';
import events from 'node:events';
import { ConfigurationBuilder } from './config/ConfigurationBuilder';
import { Configuration } from './config/Configuration';
import EventResponse from './EventResponse';
import { SearchResult } from './SearchEngine';

export type OGIAddonEvent = 'connect' | 'disconnect' | 'configure' | 'authenticate' | 'search';
export type OGIAddonClientSentEvent = 'response' | 'authenticate' | 'configure';

export type OGIAddonServerSentEvent = 'authenticate' | 'configure' | 'config-update' | 'search';
export { ConfigurationBuilder, Configuration, EventResponse, SearchResult };
const defaultPort = 7654;

export interface EventListenerTypes {
  connect: (socket: ws) => void;
  disconnect: (reason: string) => void;
  configure: (config: ConfigurationBuilder) => ConfigurationBuilder;
  response: (response: any) => void;
  authenticate: (config: any) => void;
  search: (query: string, event: EventResponse<SearchResult[]>) => void;
}

export interface WebsocketMessageClient {
  event: OGIAddonClientSentEvent;
  id?: string;
  args: any;
}
export interface WebsocketMessageServer {
  event: OGIAddonServerSentEvent;
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
  public addonInfo: OGIAddonConfiguration;
  public config: Configuration = new Configuration({});

  constructor(addonInfo: OGIAddonConfiguration) {
    this.addonInfo = addonInfo;
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
          ...this.addon.addonInfo
        }
      }));

      // send a configuration request
      let configBuilder = new ConfigurationBuilder();
      this.eventEmitter.emit('configure', configBuilder);
     
      this.socket.send(JSON.stringify({
        event: 'configure',
        args: configBuilder.build(false) 
      }));
      this.addon.config = new Configuration(configBuilder.build(true));
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
    this.socket.on('message', async (data: string) => {
      const message: WebsocketMessageServer = JSON.parse(data);
      switch (message.event) {
        case 'config-update':
          const result = this.addon.config.updateConfig(message.args);
          if (!result[0]) {
            this.respondToMessage(message.id!!, { success: false, error: result[1] });
          }
          else {
            this.respondToMessage(message.id!!, { success: true });
          }
          break 
        case 'search':
          let searchResultEvent = new EventResponse<SearchResult[]>();
          this.eventEmitter.emit('search', message.args, searchResultEvent);
          const searchResult = await this.waitForEventToRespond(searchResultEvent);         
          console.log(searchResult.data)
          this.respondToMessage(message.id!!, searchResult.data);
          break
      }
    });
  }

  private waitForEventToRespond<T>(event: EventResponse<T>): Promise<EventResponse<T>> {
    return new Promise((resolve, reject) => {
      const dataGet = setInterval(() => {
        if (event.resolved) {
          resolve(event);
          clearTimeout(timeout);
        }
      }, 5);      

      const timeout = setTimeout(() => {
        if (event.deffered) {
          clearInterval(dataGet);
          const interval = setInterval(() => {
            if (event.resolved) {
              clearInterval(interval);
              resolve(event);
            }
          }, 100);
        }
        else {
          reject('Event did not respond in time');
        }
      }, 5000)
    });
  }

  public respondToMessage(messageID: string, response: any) {
    this.socket.send(JSON.stringify({
      event: 'response',
      id: messageID,
      args: response
    }));
    console.log("dispatched response to " + messageID)
  }

  public send(event: OGIAddonEvent, ...args: Parameters<EventListenerTypes[OGIAddonEvent]>) {
    this.socket.send(JSON.stringify({
      event,
      args
    }));
  }

  public close() {
    this.socket.close();
  }
}