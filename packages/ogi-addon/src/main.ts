import ws, { WebSocket } from 'ws';
import events from 'node:events';
import { ConfigurationBuilder, ConfigurationFile } from './config/ConfigurationBuilder';
import { Configuration } from './config/Configuration';
import EventResponse from './EventResponse';
import { SearchResult } from './SearchEngine';

export type OGIAddonEvent = 'connect' | 'disconnect' | 'configure' | 'authenticate' | 'search' | 'setup';
export type OGIAddonClientSentEvent = 'response' | 'authenticate' | 'configure' | 'defer-update' | 'notification' | 'input-asked';

export type OGIAddonServerSentEvent = 'authenticate' | 'configure' | 'config-update' | 'search' | 'setup' | 'response';
export { ConfigurationBuilder, Configuration, EventResponse, SearchResult };
const defaultPort = 7654;
const version = process.env.npm_package_version;

export interface ClientSentEventTypes {
  response: any;
  authenticate: any;
  configure: ConfigurationFile;
  'defer-update': {
    logs: string[], 
    progress: number
  };
  notification: Notification;
  'input-asked': ConfigurationBuilder;
}

export interface EventListenerTypes {
  connect: (socket: ws) => void;
  disconnect: (reason: string) => void;
  configure: (config: ConfigurationBuilder) => ConfigurationBuilder;
  response: (response: any) => void;
  authenticate: (config: any) => void;
  search: (query: { type: 'steamapp', text: string }, event: EventResponse<SearchResult[]>) => void;
  setup: (
    data: { 
      path: string, 
      type: 'direct' | 'torrent' | 'magnet',
      name: string,
      usedRealDebrid: boolean, 
      multiPartFiles?: {
        name: string,
        downloadURL: string
      }[],
      steamAppID: number
    }, event: EventResponse<LibraryInfo>
  ) => void;
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

  public notify(notification: Notification) {
    this.addonWSListener.send('notification', [ notification ]);
  }
}

export interface LibraryInfo {
  name: string;
  version: string;
  cwd: string;
  steamAppID: number;
  launchExecutable: string;
  launchArguments?: string;
  capsuleImage: string;
}
interface Notification {
  type: 'warning' | 'error' | 'info' | 'success';
  message: string;
  id: string
}
class OGIAddonWSListener {
  private socket: WebSocket;
  public eventEmitter: events.EventEmitter;
  public addon: OGIAddon;

  constructor(ogiAddon: OGIAddon, eventEmitter: events.EventEmitter) {
    if (process.argv[process.argv.length - 1].split('=')[0] !== '--addonSecret') {
      throw new Error('No secret provided. This usually happens because the addon was not started by the OGI Addon Server.');
    }
    this.addon = ogiAddon;
    this.eventEmitter = eventEmitter;
    this.socket = new ws('ws://localhost:' + defaultPort);
    this.socket.on('open', () => {
      console.log('Connected to OGI Addon Server');
      console.log('OGI Addon Server Version:', version);

      // Authenticate with OGI Addon Server
      this.socket.send(JSON.stringify({
        event: 'authenticate',
        args: {
          ...this.addon.addonInfo,
          secret: process.argv[process.argv.length - 1].split('=')[1],
          ogiVersion: version
        }
      }));

      this.eventEmitter.emit('connect');

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
      console.log("Disconnected from OGI Addon Server")
      console.log(reason.toString())
      this.socket.close();
    });

    this.registerMessageReceiver();
  }

  private async userInputAsked(configBuilt: ConfigurationBuilder, name: string, description: string, socket: WebSocket): Promise<{ [key: string]: number | boolean | string }> {
    const config = configBuilt.build(false);
    const id = Math.random().toString(36).substring(7);
    if (!socket) {
      return {};
    }
    socket.send(JSON.stringify({
      event: 'input-asked',
      args: {
        config,
        name,
        description
      },
      id: id
    }));
    return await this.waitForResponseFromServer(id);
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
          let searchResultEvent = new EventResponse<SearchResult[]>((screen, name, description) => this.userInputAsked(screen, name, description, this.socket));
          this.eventEmitter.emit('search', message.args, searchResultEvent);
          const searchResult = await this.waitForEventToRespond(searchResultEvent);         
          console.log(searchResult.data)
          this.respondToMessage(message.id!!, searchResult.data);
          break
        case 'setup':
          let setupEvent = new EventResponse<LibraryInfo>((screen, name, description) => this.userInputAsked(screen, name, description, this.socket));
          this.eventEmitter.emit('setup', { path: message.args.path, steamAppID: message.args.steamAppID, type: message.args.type, name: message.args.name, usedRealDebrid: message.args.usedRealDebrid, multiPartFiles: message.args.multiPartFiles }, setupEvent);
          const interval = setInterval(() => {
            if (setupEvent.resolved) {
              clearInterval(interval);
              return;
            }
            this.send('defer-update', { 
              logs: setupEvent.logs,
              deferID: message.args.deferID,
              progress: setupEvent.progress
            } as any);
          }, 100);
          const setupResult = await this.waitForEventToRespond(setupEvent);
          this.respondToMessage(message.id!!, setupResult.data);
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

  public waitForResponseFromServer<T>(messageID: string): Promise<T> {
    return new Promise((resolve) => {
      const waiter = (data: string) => {
        const message: WebsocketMessageClient = JSON.parse(data);
        if (message.event !== 'response') {
          this.socket.once('message', waiter);
          return;
        }
        console.log("received response from " + messageID)

        if (message.id === messageID) {
          resolve(message.args);
        }
        else {
          this.socket.once('message', waiter);
        }
      }
      this.socket.once('message', waiter);
    });
  }

  public send(event: OGIAddonClientSentEvent, args: Parameters<ClientSentEventTypes[OGIAddonClientSentEvent]>) {
    this.socket.send(JSON.stringify({
      event,
      args
    }));
  }

  public close() {
    this.socket.close();
  }

  
}