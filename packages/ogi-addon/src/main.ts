import ws, { WebSocket } from 'ws';
import events from 'node:events';
import {
  ConfigurationBuilder,
  ConfigurationFile,
} from './config/ConfigurationBuilder';
import { Configuration } from './config/Configuration';
import EventResponse from './EventResponse';
import { SearchResult } from './SearchEngine';
import Fuse, { IFuseOptions } from 'fuse.js';

export type OGIAddonEvent =
  | 'connect'
  | 'disconnect'
  | 'configure'
  | 'authenticate'
  | 'search'
  | 'setup'
  | 'library-search'
  | 'game-details'
  | 'exit'
  | 'request-dl'
  | 'catalog';

export type OGIAddonClientSentEvent =
  | 'response'
  | 'authenticate'
  | 'configure'
  | 'defer-update'
  | 'notification'
  | 'input-asked'
  | 'get-app-details'
  | 'flag'
  | 'task-update';

export type OGIAddonServerSentEvent =
  | 'authenticate'
  | 'configure'
  | 'config-update'
  | 'search'
  | 'setup'
  | 'response'
  | 'library-search'
  | 'game-details'
  | 'request-dl'
  | 'catalog';
export { ConfigurationBuilder, Configuration, EventResponse, SearchResult };
const defaultPort = 7654;
import pjson from '../package.json';
export const VERSION = pjson.version;

export interface ClientSentEventTypes {
  response: any;
  authenticate: {
    name: string;
    id: string;
    description: string;
    version: string;
    author: string;
  };
  configure: ConfigurationFile;
  'defer-update': {
    logs: string[];
    progress: number;
  };
  notification: Notification;
  'input-asked': ConfigurationBuilder;
  'task-update': {
    id: string;
    progress: number;
    logs: string[];
    finished: boolean;
    failed: string | undefined;
  };
  'get-app-details': {
    appID: number;
    storefront: string;
  };
  flag: {
    flag: string;
    value: string | string[];
  };
}

export type BasicLibraryInfo = {
  name: string;
  capsuleImage: string;
  appID: number;
  storefront: string;
};

export interface EventListenerTypes {
  /**
   * This event is emitted when the addon connects to the OGI Addon Server. Addon does not need to resolve anything.
   * @param socket
   * @returns
   */
  connect: (socket: ws) => void;

  /**
   * This event is emitted when the client requests for the addon to disconnect. Addon does not need to resolve this event, but we recommend `process.exit(0)` so the addon can exit gracefully instead of by force by the addon server.
   * @param reason
   * @returns
   */
  disconnect: (reason: string) => void;
  /**
   * This event is emitted when the client requests for the addon to configure itself. Addon should resolve the event with the internal configuration. (See ConfigurationBuilder)
   * @param config
   * @returns
   */
  configure: (config: ConfigurationBuilder) => ConfigurationBuilder;
  /**
   * This event is called when the client provides a response to any event. This should be treated as middleware.
   * @param response
   * @returns
   */
  response: (response: any) => void;

  /**
   * This event is called when the client requests for the addon to authenticate itself. You don't need to provide any info.
   * @param config
   * @returns
   */
  authenticate: (config: any) => void;
  /**
   * This event is emitted when the client requests for a torrent/direct download search to be performed. Addon is given the gameID (could be a steam appID or custom store appID), along with the storefront type. Addon should resolve the event with the search results. (See SearchResult)
   * @param query
   * @param event
   * @returns
   */
  search: (
    query: { storefront: string; appID: number },
    event: EventResponse<SearchResult[]>
  ) => void;
  /**
   * This event is emitted when the client requests for app setup to be performed. Addon should resolve the event with the metadata for the library entry. (See LibraryInfo)
   * @param data
   * @param event
   * @returns
   */
  setup: (
    data: {
      path: string;
      type: 'direct' | 'torrent' | 'magnet';
      name: string;
      usedRealDebrid: boolean;
      multiPartFiles?: {
        name: string;
        downloadURL: string;
      }[];
      appID: number;
      storefront: string;
    },
    event: EventResponse<
      Omit<
        LibraryInfo,
        | 'capsuleImage'
        | 'coverImage'
        | 'name'
        | 'appID'
        | 'storefront'
        | 'addonsource'
      >
    >
  ) => void;

  /**
   * This event is emitted when the client requires for a search to be performed. Input is the search query.
   * @param query
   * @param event
   * @returns
   */
  'library-search': (
    query: string,
    event: EventResponse<BasicLibraryInfo[]>
  ) => void;

  /**
   * This event is emitted when the client requests for a game details to be fetched. Addon should resolve the event with the game details. This is used to generate a store page for the game.
   * @param appID
   * @param event
   * @returns
   */
  'game-details': (appID: number, event: EventResponse<StoreData>) => void;

  /**
   * This event is emitted when the client requests for the addon to exit. Use this to perform any cleanup tasks, ending with a `process.exit(0)`.
   * @returns
   */
  exit: () => void;

  /**
   * This event is emitted when the client requests for a download to be performed with the 'request' type. Addon should resolve the event with a SearchResult containing the actual download info.
   * @param appID
   * @param info
   * @param event
   * @returns
   */
  'request-dl': (
    appID: number,
    info: SearchResult,
    event: EventResponse<SearchResult>
  ) => void;

  /**
   * This event is emitted when the client requests for a catalog to be fetched. Addon should resolve the event with the catalog.
   * @param event
   * @returns
   */
  catalog: (
    event: Omit<
      EventResponse<{
        [key: string]: {
          name: string;
          description: string;
          listings: BasicLibraryInfo[];
        };
      }>,
      'askForInput'
    >
  ) => void;
}

export interface StoreData {
  name: string;
  publishers: string[];
  developers: string[];
  appID: number;
  releaseDate: string;
  capsuleImage: string;
  coverImage: string;
  basicDescription: string;
  description: string;
  headerImage: string;
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

/**
 * The configuration for the addon. This is used to identify the addon and provide information about it.
 * Storefronts is an array of names of stores that the addon supports.
 */
export interface OGIAddonConfiguration {
  name: string;
  id: string;
  description: string;
  version: string;

  author: string;
  repository: string;
  storefronts: string[];
}

/**
 * The main class for the OGI Addon. This class is used to interact with the OGI Addon Server. The OGI Addon Server provides a `--addonSecret` to the addon so it can securely connect.
 * @example
 * ```typescript
 * const addon = new OGIAddon({
 *  name: 'Test Addon',
 *   id: 'test-addon',
 *  description: 'A test addon',
 *  version: '1.0.0',
 *  author: 'OGI Developers',
 *  repository: ''
 * });
 * ```
 *
 */
export default class OGIAddon {
  public eventEmitter = new events.EventEmitter();
  public addonWSListener: OGIAddonWSListener;
  public addonInfo: OGIAddonConfiguration;
  public config: Configuration = new Configuration({});
  private eventsAvailable: OGIAddonEvent[] = [];
  private registeredConnectEvent: boolean = false;

  constructor(addonInfo: OGIAddonConfiguration) {
    this.addonInfo = addonInfo;
    this.addonWSListener = new OGIAddonWSListener(this, this.eventEmitter);
  }

  /**
   * Register an event listener for the addon. (See EventListenerTypes)
   * @param event {OGIAddonEvent}
   * @param listener {EventListenerTypes[OGIAddonEvent]}
   */
  public on<T extends OGIAddonEvent>(
    event: T,
    listener: EventListenerTypes[T]
  ) {
    this.eventEmitter.on(event, listener);
    this.eventsAvailable.push(event);
    // wait for the addon to be connected
    if (!this.registeredConnectEvent) {
      this.addonWSListener.eventEmitter.once('connect', () => {
        this.addonWSListener.send('flag', {
          flag: 'events-available',
          value: this.eventsAvailable,
        });
      });
      this.registeredConnectEvent = true;
    }
  }

  public emit<T extends OGIAddonEvent>(
    event: T,
    ...args: Parameters<EventListenerTypes[T]>
  ) {
    this.eventEmitter.emit(event, ...args);
  }

  /**
   * Notify the client using a notification. Provide the type of notification, the message, and an ID.
   * @param notification {Notification}
   */
  public notify(notification: Notification) {
    this.addonWSListener.send('notification', [notification]);
  }

  /**
   * Get the app details for a given appID and storefront.
   * @param appID {number}
   * @param storefront {string}
   * @returns {Promise<StoreData>}
   */
  public async getAppDetails(appID: number, storefront: string) {
    const id = this.addonWSListener.send('get-app-details', {
      appID,
      storefront,
    });
    return await this.addonWSListener.waitForResponseFromServer<
      StoreData | undefined
    >(id);
  }

  /**
   * Notify the OGI Addon Server that you are performing a background task. This can be used to help users understand what is happening in the background.
   * @param id {string}
   * @param progress {number}
   * @param logs {string[]}
   */
  public async task() {
    const id = Math.random().toString(36).substring(7);
    const progress = 0;
    const logs: string[] = [];
    const task = new CustomTask(this.addonWSListener, id, progress, logs);
    this.addonWSListener.send('task-update', {
      id,
      progress,
      logs,
      finished: false,
      failed: undefined,
    });
    return task;
  }
}

export class CustomTask {
  public readonly id: string;
  public progress: number;
  public logs: string[];
  public finished: boolean = false;
  public ws: OGIAddonWSListener;
  public failed: string | undefined = undefined;
  constructor(
    ws: OGIAddonWSListener,
    id: string,
    progress: number,
    logs: string[]
  ) {
    this.id = id;
    this.progress = progress;
    this.logs = logs;
    this.ws = ws;
  }
  public log(log: string) {
    this.logs.push(log);
    this.update();
  }
  public finish() {
    this.finished = true;
    this.update();
  }
  public fail(message: string) {
    this.failed = message;
    this.update();
  }
  public setProgress(progress: number) {
    this.progress = progress;
    this.update();
  }
  public update() {
    this.ws.send('task-update', {
      id: this.id,
      progress: this.progress,
      logs: this.logs,
      finished: this.finished,
      failed: this.failed,
    });
  }
}
/**
 * A search tool wrapper over Fuse.js for the OGI Addon. This tool is used to search for items in the library.
 * @example
 * ```typescript
 * const searchTool = new SearchTool<LibraryInfo>([{ name: 'test', appID: 123 }, { name: 'test2', appID: 124 }], ['name']);
 * const results = searchTool.search('test', 10);
 * ```
 */
export class SearchTool<T> {
  private fuse: Fuse<T>;
  constructor(
    items: T[],
    keys: string[],
    options: Omit<IFuseOptions<T>, 'keys'> = {
      threshold: 0.3,
      includeScore: true,
    }
  ) {
    this.fuse = new Fuse(items, {
      keys,
      ...options,
    });
  }
  public search(query: string, limit: number = 10): T[] {
    return this.fuse
      .search(query)
      .slice(0, limit)
      .map((result) => result.item);
  }
  public addItems(items: T[]) {
    items.map((item) => this.fuse.add(item));
  }
}
/**
 * Library Info is the metadata for a library entry after setting up a game.
 */
export interface LibraryInfo {
  name: string;
  version: string;
  cwd: string;
  appID: number;
  launchExecutable: string;
  launchArguments?: string;
  capsuleImage: string;
  storefront: string;
  addonsource: string;
  coverImage: string;
  titleImage?: string;
}
interface Notification {
  type: 'warning' | 'error' | 'info' | 'success';
  message: string;
  id: string;
}
class OGIAddonWSListener {
  private socket: WebSocket;
  public eventEmitter: events.EventEmitter;
  public addon: OGIAddon;

  constructor(ogiAddon: OGIAddon, eventEmitter: events.EventEmitter) {
    if (
      process.argv[process.argv.length - 1].split('=')[0] !== '--addonSecret'
    ) {
      throw new Error(
        'No secret provided. This usually happens because the addon was not started by the OGI Addon Server.'
      );
    }
    this.addon = ogiAddon;
    this.eventEmitter = eventEmitter;
    this.socket = new ws('ws://localhost:' + defaultPort);
    this.socket.on('open', () => {
      console.log('Connected to OGI Addon Server');
      console.log('OGI Addon Server Version:', VERSION);

      // Authenticate with OGI Addon Server
      this.send('authenticate', {
        ...this.addon.addonInfo,
        secret: process.argv[process.argv.length - 1].split('=')[1],
        ogiVersion: VERSION,
      });

      this.eventEmitter.emit('connect');

      // send a configuration request
      let configBuilder = new ConfigurationBuilder();
      this.eventEmitter.emit('configure', configBuilder);
      this.send('configure', configBuilder.build(false));
      this.addon.config = new Configuration(configBuilder.build(true));
    });

    this.socket.on('error', (error) => {
      if (error.message.includes('Failed to connect')) {
        throw new Error(
          'OGI Addon Server is not running/is unreachable. Please start the server and try again.'
        );
      }
      console.error('An error occurred:', error);
    });

    this.socket.on('close', (code, reason) => {
      if (code === 1008) {
        console.error('Authentication failed:', reason);
        return;
      }
      this.eventEmitter.emit('disconnect', reason);
      console.log('Disconnected from OGI Addon Server');
      console.error(reason.toString());
      this.eventEmitter.emit('exit');
      this.socket.close();
    });

    this.registerMessageReceiver();
  }

  private async userInputAsked(
    configBuilt: ConfigurationBuilder,
    name: string,
    description: string,
    socket: WebSocket
  ): Promise<{ [key: string]: number | boolean | string }> {
    const config = configBuilt.build(false);
    const id = Math.random().toString(36).substring(7);
    if (!socket) {
      return {};
    }
    socket.send(
      JSON.stringify({
        event: 'input-asked',
        args: {
          config,
          name,
          description,
        },
        id: id,
      })
    );
    return await this.waitForResponseFromServer(id);
  }

  private registerMessageReceiver() {
    this.socket.on('message', async (data: string) => {
      const message: WebsocketMessageServer = JSON.parse(data);
      switch (message.event) {
        case 'config-update':
          const result = this.addon.config.updateConfig(message.args);
          if (!result[0]) {
            this.respondToMessage(message.id!!, {
              success: false,
              error: result[1],
            });
          } else {
            this.respondToMessage(message.id!!, { success: true });
          }
          break;
        case 'search':
          let searchResultEvent = new EventResponse<SearchResult[]>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );
          this.eventEmitter.emit('search', message.args, searchResultEvent);
          const searchResult =
            await this.waitForEventToRespond(searchResultEvent);
          this.respondToMessage(message.id!!, searchResult.data);
          break;
        case 'setup':
          let setupEvent = new EventResponse<LibraryInfo>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );
          this.eventEmitter.emit(
            'setup',
            {
              path: message.args.path,
              appID: message.args.appID,
              storefront: message.args.storefront,
              type: message.args.type,
              name: message.args.name,
              usedRealDebrid: message.args.usedRealDebrid,
              multiPartFiles: message.args.multiPartFiles,
            },
            setupEvent
          );
          const interval = setInterval(() => {
            if (setupEvent.resolved) {
              clearInterval(interval);
              return;
            }
            this.send('defer-update', {
              logs: setupEvent.logs,
              deferID: message.args.deferID,
              progress: setupEvent.progress,
              failed: setupEvent.failed,
            } as ClientSentEventTypes['defer-update']);
          }, 100);
          const setupResult = await this.waitForEventToRespond(setupEvent);
          this.respondToMessage(message.id!!, setupResult.data);
          break;
        case 'library-search':
          let librarySearchEvent = new EventResponse<BasicLibraryInfo[]>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );
          if (this.eventEmitter.listenerCount('game-details') === 0) {
            this.respondToMessage(message.id!!, []);
            break;
          }
          this.eventEmitter.emit(
            'library-search',
            message.args,
            librarySearchEvent
          );
          const librarySearchResult =
            await this.waitForEventToRespond(librarySearchEvent);
          this.respondToMessage(message.id!!, librarySearchResult.data);
          break;
        case 'game-details':
          let gameDetailsEvent = new EventResponse<StoreData | undefined>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );
          if (this.eventEmitter.listenerCount('game-details') === 0) {
            this.respondToMessage(message.id!!, {
              error: 'No event listener for game-details',
            });
            break;
          }
          this.eventEmitter.emit(
            'game-details',
            message.args,
            gameDetailsEvent
          );
          const gameDetailsResult =
            await this.waitForEventToRespond(gameDetailsEvent);
          this.respondToMessage(message.id!!, gameDetailsResult.data);
          break;
        case 'request-dl':
          let requestDLEvent = new EventResponse<SearchResult>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );
          if (this.eventEmitter.listenerCount('request-dl') === 0) {
            this.respondToMessage(message.id!!, {
              error: 'No event listener for request-dl',
            });
            break;
          }
          this.eventEmitter.emit(
            'request-dl',
            message.args.appID,
            message.args.info,
            requestDLEvent
          );
          const requestDLResult =
            await this.waitForEventToRespond(requestDLEvent);
          if (requestDLEvent.failed) {
            this.respondToMessage(message.id!!, {
              statusError: requestDLEvent.failed,
            });
            break;
          }
          if (
            requestDLEvent.data === undefined ||
            requestDLEvent.data?.downloadType === 'request'
          ) {
            throw new Error(
              'Request DL event did not return a valid result. Please ensure that the event does not resolve with another `request` download type.'
            );
          }
          this.respondToMessage(message.id!!, requestDLResult.data);
          break;
        case 'catalog':
          let catalogEvent = new EventResponse<{
            [key: string]: {
              name: string;
              description: string;
              listings: BasicLibraryInfo[];
            };
          }>();
          this.eventEmitter.emit('catalog', catalogEvent);
          const catalogResult = await this.waitForEventToRespond(catalogEvent);
          this.respondToMessage(message.id!!, catalogResult.data);
          break;
      }
    });
  }

  private waitForEventToRespond<T>(
    event: EventResponse<T>
  ): Promise<EventResponse<T>> {
    // check the handlers to see if there even is any
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
        } else {
          reject('Event did not respond in time');
        }
      }, 5000);
    });
  }

  public respondToMessage(messageID: string, response: any) {
    this.socket.send(
      JSON.stringify({
        event: 'response',
        id: messageID,
        args: response,
      })
    );
    console.log('dispatched response to ' + messageID);
  }

  public waitForResponseFromServer<T>(messageID: string): Promise<T> {
    return new Promise((resolve) => {
      const waiter = (data: string) => {
        const message: WebsocketMessageClient = JSON.parse(data);
        if (message.event !== 'response') {
          this.socket.once('message', waiter);
          return;
        }
        console.log('received response from ' + messageID);

        if (message.id === messageID) {
          resolve(message.args);
        } else {
          this.socket.once('message', waiter);
        }
      };
      this.socket.once('message', waiter);
    });
  }

  public send(
    event: OGIAddonClientSentEvent,
    args: ClientSentEventTypes[OGIAddonClientSentEvent]
  ): string {
    // generate a random id
    const id = Math.random().toString(36).substring(7);
    this.socket.send(
      JSON.stringify({
        event,
        args,
        id,
      })
    );
    return id;
  }

  public close() {
    this.socket.close();
  }
}
