import { WebSocket, type RawData } from 'ws';
import { EventResponseSocket, randomMessageId } from '@ogi-sdk/connect';
import type { WebsocketMessage } from '@ogi-sdk/connect';
import events from 'node:events';
import { ConfigurationBuilder } from './config/ConfigurationBuilder';
import type { ConfigurationFile } from './config/ConfigurationBuilder';
import { Configuration, DefiniteConfig } from './config/Configuration';
import EventResponse from './EventResponse';
import type { SearchResult } from './SearchEngine';
import Fuse, { IFuseOptions } from 'fuse.js';

/**
 * Exposed events that the programmer can use to listen to and emit events.
 */
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
  | 'check-for-updates'
  | 'request-dl'
  | 'catalog'
  | 'launch-app';

/**
 * The events that the client can send to the server and are handled by the server.
 */
export type OGIAddonClientSentEvent =
  | 'response'
  | 'authenticate'
  | 'configure'
  | 'defer-update'
  | 'notification'
  | 'input-asked'
  | 'get-app-details'
  | 'search-app-name'
  | 'flag'
  | 'task-update';

/**
 * The events that the server sends to the client
 * This is the events that the server can send to the client and are handled by the client.
 */
export type OGIAddonServerSentEvent =
  | 'authenticate'
  | 'configure'
  | 'config-update'
  | 'launch-app'
  | 'search'
  | 'setup'
  | 'response'
  | 'library-search'
  | 'check-for-updates'
  | 'task-run'
  | 'game-details'
  | 'request-dl'
  | 'catalog';
export { ConfigurationBuilder, Configuration, EventResponse };
export { extraction };
export type { SearchResult };
const defaultPort = 7654;
import pjson from '../package.json';
import { z } from 'zod';
import { extraction } from './extraction';
export const VERSION = pjson.version;

export interface ClientToServerEventArgs {
  response: any;
  authenticate: {
    secret: string;
    ogiVersion: string;
  } & OGIAddonConfiguration;
  configure: ConfigurationFile;
  'defer-update': {
    logs: string[];
    progress: number;
    deferID: string;
    failed: string | undefined;
  };
  notification: Notification;
  'input-asked': {
    config: ConfigurationFile;
    name: string;
    description: string;
  };
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
  'search-app-name': {
    query: string;
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

export interface CatalogSection {
  name: string;
  description: string;
  listings: BasicLibraryInfo[];
}

export interface CatalogCarouselItem {
  name: string;
  description: string;
  carouselImage: string;
  fullBannerImage?: string;
  appID?: number;
  storefront?: string;
  capsuleImage?: string;
}

export interface CatalogWithCarousel {
  sections: Record<string, CatalogSection>;
  carousel?: Record<string, CatalogCarouselItem> | CatalogCarouselItem[];
}

export type CatalogResponse =
  | Record<string, CatalogSection>
  | CatalogWithCarousel;

/**
 * UMU ID format: 'steam:${number}' or 'umu:${string | number}'
 * - steam:${number} → maps to umu-${number} for Steam games
 * - umu:${string | number} → maps to umu-${string | number} for non-Steam games
 */
export type UmuId = `steam:${number}` | `umu:${string | number}`;

export type SetupEventResponse = Omit<
  LibraryInfo,
  | 'capsuleImage'
  | 'coverImage'
  | 'name'
  | 'appID'
  | 'storefront'
  | 'addonsource'
  | 'titleImage'
> & {
  redistributables?: {
    name: string;
    path: string;
  }[];
  /**
   * UMU Proton integration configuration
   */
  umu?: {
    /**
     * UMU ID for the game. Format: 'steam:${number}' or 'umu:${string | number}'
     * - steam:${number} → maps to umu-${number} for Steam games
     * - umu:${string | number} → maps to umu-${string | number} for non-Steam games
     */
    umuId: UmuId;
    /**
     * Optional DLL overrides. Can be WINEDLLOVERRIDES-style (e.g. "dinput8=n,b") or bare DLL names.
     * Bare names get "=n,b" inferred; entries that already include "=..." are used as-is.
     */
    dllOverrides?: string[];
    /**
     * Optional PROTONPATH override to use for UMU launches.
     * Omit this unless you absolutely need a specific Proton build/path.
     */
    protonVersion?: string;
    /**
     * Optional store identifier for protonfixes (e.g., 'gog', 'egs', 'none')
     */
    store?: string;
    /**
     * Cached Steam shortcut app ID after adding UMU game to Steam (avoids re-adding on each launch)
     */
    steamShortcutId?: number;
  };
};

export interface EventListenerTypes {
  /**
   * This event is emitted when the addon connects to the OGI Addon Server. Addon does not need to resolve anything.
   * @param event
   * @returns
   */
  connect: (event: EventResponse<void>) => void;

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
    query: {
      storefront: string;
      appID: number;
    } & (
      | {
          for: 'game' | 'task' | 'all';
        }
      | {
          for: 'update';
          libraryInfo: LibraryInfo;
        }
    ),
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
      type: 'direct' | 'torrent' | 'magnet' | 'empty';
      name: string;
      usedRealDebrid: boolean;
      clearOldFilesBeforeUpdate?: boolean;
      multiPartFiles?: {
        name: string;
        downloadURL: string;
      }[];
      appID: number;
      storefront: string;
      manifest?: Record<string, unknown>;
    } & (
      | {
          for: 'game';
        }
      | {
          for: 'update';
          currentLibraryInfo: LibraryInfo;
        }
    ),
    event: EventResponse<SetupEventResponse>
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
  'game-details': (
    details: { appID: number; storefront: string },
    event: EventResponse<StoreData | undefined>
  ) => void;

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
  catalog: (event: Omit<EventResponse<CatalogResponse>, 'askForInput'>) => void;

  /**
   * This event is emitted when the client requests for an addon to check for updates. Addon should resolve the event with the update information.
   * @param data
   * @param event
   * @returns
   */
  'check-for-updates': (
    data: { appID: number; storefront: string; currentVersion: string },
    event: EventResponse<
      | {
          available: true;
          version: string;
        }
      | {
          available: false;
        }
    >
  ) => void;

  /**
   * This event is emitted when the client is going to launch an app. Addon should use this to perform any pre or post launch tasks.
   * @param data {LibraryInfo} The library information for the app to be launched.
   * @param launchType { 'pre' | 'post' } The type of launch task to perform.
   * @param event {EventResponse<void>} The event response from the server.
   */
  'launch-app': (
    data: { libraryInfo: LibraryInfo; launchType: 'pre' | 'post' },
    event: EventResponse<void>
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
  latestVersion: string;
}
export interface WebsocketMessageClient extends WebsocketMessage {
  event: OGIAddonClientSentEvent;
}
export interface WebsocketMessageServer extends WebsocketMessage {
  event: OGIAddonServerSentEvent;
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
  private taskHandlers: Map<
    string,
    (
      task: Task,
      data: {
        manifest: Record<string, unknown>;
        downloadPath: string;
        name: string;
        libraryInfo: LibraryInfo;
      }
    ) => Promise<void> | void
  > = new Map();

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
    return await this.addonWSListener.requestResponse<StoreData | undefined>(
      'get-app-details',
      {
        appID,
        storefront,
      }
    );
  }

  public async searchGame(query: string, storefront: string) {
    return await this.addonWSListener.requestResponse<BasicLibraryInfo[]>(
      'search-app-name',
      {
        query,
        storefront,
      }
    );
  }

  /**
   * Notify the OGI Addon Server that you are performing a background task. This can be used to help users understand what is happening in the background.
   * @returns {Promise<Task>} A Task instance for managing the background task.
   */
  public async task(): Promise<Task> {
    const id = Math.random().toString(36).substring(7);
    const progress = 0;
    const logs: string[] = [];
    const task = new Task(this.addonWSListener, id, progress, logs);
    this.addonWSListener.send('task-update', {
      id,
      progress,
      logs,
      finished: false,
      failed: undefined,
    });
    return task;
  }

  /**
   * Register a task handler for a specific task name. The task name should match the taskName field in SearchResult or ActionOption.
   * @param taskName {string} The name of the task (should match taskName in SearchResult or ActionOption.setTaskName()).
   * @param handler {(task: Task, data: { manifest: Record<string, unknown>; downloadPath: string; name: string; libraryInfo: LibraryInfo }) => Promise<void> | void} The handler function.
   * @example
   * ```typescript
   * addon.onTask('clearCache', async (task) => {
   *   task.log('Clearing cache...');
   *   task.setProgress(50);
   *   await clearCacheFiles();
   *   task.setProgress(100);
   *   task.complete();
   * });
   * ```
   */
  public onTask(
    taskName: string,
    handler: (
      task: Task,
      data: {
        manifest: Record<string, unknown>;
        downloadPath: string;
        name: string;
        libraryInfo: LibraryInfo;
      }
    ) => Promise<void> | void
  ): void {
    this.taskHandlers.set(taskName, handler);
  }

  /**
   * Check if a task handler is registered for the given task name.
   * @param taskName {string} The task name to check.
   * @returns {boolean} True if a handler is registered.
   */
  public hasTaskHandler(taskName: string): boolean {
    return this.taskHandlers.has(taskName);
  }

  /**
   * Get a task handler for the given task name.
   * @param taskName {string} The task name.
   * @returns The handler function or undefined if not found.
   */
  public getTaskHandler(taskName: string):
    | ((
        task: Task,
        data: {
          manifest: Record<string, unknown>;
          downloadPath: string;
          name: string;
          libraryInfo?: LibraryInfo;
        }
      ) => Promise<void> | void)
    | undefined {
    return this.taskHandlers.get(taskName);
  }

  /**
   * Extract a file using 7-Zip on Windows, unzip on Linux/Mac.
   * @param path {string}
   * @param outputPath {string}
   * @returns {Promise<void>}
   */
  public async extractFile(path: string, outputPath: string) {
    return await extraction(path, outputPath);
  }
}

/**
 * A unified task API for both server-initiated tasks (via onTask handlers)
 * and addon-initiated background tasks (via addon.task()).
 * Provides chainable methods for logging, progress updates, and completion.
 */
export class Task {
  // EventResponse-based mode (for onTask handlers)
  private event: EventResponse<void> | undefined;

  // WebSocket-based mode (for addon.task())
  private ws: OGIAddonWSListener | undefined;
  private readonly id: string | undefined;
  private progress: number = 0;
  private logs: string[] = [];
  private finished: boolean = false;
  private failed: string | undefined = undefined;

  /**
   * Construct a Task from an EventResponse (for onTask handlers).
   * @param event {EventResponse<void>} The event response to wrap.
   */
  constructor(event: EventResponse<void>);

  /**
   * Construct a Task from WebSocket listener (for addon.task()).
   * @param ws {OGIAddonWSListener} The WebSocket listener.
   * @param id {string} The task ID.
   * @param progress {number} Initial progress (0-100).
   * @param logs {string[]} Initial logs array.
   */
  constructor(
    ws: OGIAddonWSListener,
    id: string,
    progress: number,
    logs: string[]
  );

  constructor(
    eventOrWs: EventResponse<void> | OGIAddonWSListener,
    id?: string,
    progress?: number,
    logs?: string[]
  ) {
    if (eventOrWs instanceof EventResponse) {
      // EventResponse-based mode
      this.event = eventOrWs;
      this.event.defer();
    } else {
      // WebSocket-based mode
      this.ws = eventOrWs;
      this.id = id!;
      this.progress = progress ?? 0;
      this.logs = logs ?? [];
    }
  }

  /**
   * Log a message to the task. Returns this for chaining.
   * @param message {string} The message to log.
   */
  log(message: string): this {
    if (this.event) {
      this.event.log(message);
    } else {
      this.logs.push(message);
      this.update();
    }
    return this;
  }

  /**
   * Set the progress of the task (0-100). Returns this for chaining.
   * @param progress {number} The progress value (0-100).
   */
  setProgress(progress: number): this {
    if (this.event) {
      this.event.progress = progress;
    } else {
      this.progress = progress;
      this.update();
    }
    return this;
  }

  /**
   * Complete the task successfully.
   */
  complete(): void {
    if (this.event) {
      this.event.complete();
    } else {
      this.finished = true;
      this.update();
    }
  }

  /**
   * Fail the task with an error message.
   * @param message {string} The error message.
   */
  fail(message: string): void {
    if (this.event) {
      this.event.fail(message);
    } else {
      this.failed = message;
      this.update();
    }
  }

  /**
   * Ask the user for input using a ConfigurationBuilder screen.
   * Only available for EventResponse-based tasks (onTask handlers).
   * The return type is inferred from the ConfigurationBuilder's accumulated option types.
   * @param name {string} The name/title of the input prompt.
   * @param description {string} The description of what input is needed.
   * @param screen {ConfigurationBuilder<U>} The configuration builder for the input form.
   * @returns {Promise<U>} The user's input with types matching the configuration options.
   * @throws {Error} If called on a WebSocket-based task.
   */
  async askForInput<U extends Record<string, string | number | boolean>>(
    name: string,
    description: string,
    screen: ConfigurationBuilder<U>
  ): Promise<U> {
    if (!this.event) {
      throw new Error(
        'askForInput() is only available for EventResponse-based tasks (onTask handlers)'
      );
    }
    return this.event.askForInput(name, description, screen);
  }

  /**
   * Update the task state (for WebSocket-based tasks only).
   * Called automatically when using log(), setProgress(), complete(), or fail().
   */
  private update(): void {
    if (this.ws && this.id !== undefined) {
      this.ws.send('task-update', {
        id: this.id,
        progress: this.progress,
        logs: this.logs,
        finished: this.finished,
        failed: this.failed,
      });
    }
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
export const ZodLibraryInfo = z.object({
  name: z.string(),
  version: z.string(),
  cwd: z.string(),
  appID: z.number(),
  launchExecutable: z.string(),
  launchArguments: z.string().optional(),
  launchEnv: z.record(z.string(), z.string()).optional(),
  capsuleImage: z.string(),
  storefront: z.string(),
  addonsource: z.string(),
  coverImage: z.string(),
  titleImage: z.string().optional(),
  /**
   * UMU Proton integration configuration (Linux only)
   */
  umu: z
    .object({
      umuId: z
        .string()
        .regex(
          /^(steam|umu):\S+$/,
          'Must be in format steam:{number} or umu:{string | number}'
        ),
      dllOverrides: z.array(z.string()).optional(),
      protonVersion: z.string().optional(),
      store: z.string().optional(),
      winePrefixPath: z.string().optional(),
      steamShortcutId: z.number().optional(),
    })
    .optional(),
  /**
   * Redistributables to install (for backward compatibility)
   */
  redistributables: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
      })
    )
    .optional(),
});
export type LibraryInfo = z.infer<typeof ZodLibraryInfo>;

/** Payload shape for server-sent `task-run` messages. */
export type TaskRunMessageArgs = {
  manifest?: Record<string, unknown>;
  downloadPath?: string;
  name?: string;
  taskName?: string;
  libraryInfo?: LibraryInfo;
  deferID?: string;
};

export interface Notification {
  type: 'warning' | 'error' | 'info' | 'success';
  message: string;
  id: string;
}
class OGIAddonWSListener {
  private socket: WebSocket;
  private transport: EventResponseSocket<
    WebsocketMessageServer,
    WebsocketMessageClient
  >;
  public eventEmitter: events.EventEmitter;
  public addon: OGIAddon;

  private normalizeRawData(raw: RawData): string | Buffer {
    if (typeof raw === 'string') {
      return raw;
    }
    if (Buffer.isBuffer(raw)) {
      return raw;
    }
    if (Array.isArray(raw)) {
      return Buffer.concat(raw);
    }
    return Buffer.from(new Uint8Array(raw));
  }

  constructor(ogiAddon: OGIAddon, eventEmitter: events.EventEmitter) {
    const secret = process.argv
      .find((arg) => arg.startsWith('--addonSecret='))
      ?.split('=')[1];
    if (!secret) {
      throw new Error(
        'No secret provided. This usually happens because the addon was not started by the OGI Addon Server.'
      );
    }

    // get the port from the arguments
    let port = process.argv
      .find((arg) => arg.startsWith('--addonPort='))
      ?.split('=')[1];
    if (!port) {
      port = defaultPort.toString();
    }

    this.addon = ogiAddon;
    this.eventEmitter = eventEmitter;
    this.socket = new WebSocket('ws://localhost:' + port);
    this.transport = new EventResponseSocket(this.socket);
    this.socket.on('open', () => {
      console.log('Connected to OGI Addon Server');
      console.log('OGI Addon Server Version:', VERSION);

      // Authenticate with OGI Addon Server
      this.send('authenticate' as OGIAddonClientSentEvent, {
        ...this.addon.addonInfo,
        secret,
        ogiVersion: VERSION,
      });

      // send a configuration request
      let configBuilder = new ConfigurationBuilder();
      this.eventEmitter.emit('configure', configBuilder);
      this.send('configure', configBuilder.build(false));
      this.addon.config = new Configuration(configBuilder.build(true));

      // wait for the config-update to be received then send connect
      const configListener = (raw: RawData) => {
        const message = this.transport.parseMessage(this.normalizeRawData(raw));
        if (!message) {
          return;
        }
        if (this.transport.resolveIncomingResponse(message)) {
          return;
        }
        if (message.event === 'config-update') {
          console.log('Config update received');
          this.socket.off('message', configListener);
          this.eventEmitter.emit(
            'connect',
            new EventResponse<void>((screen, name, description) => {
              return this.userInputAsked(screen, name, description);
            })
          );
        }
      };
      this.socket.on('message', configListener);
    });

    this.socket.on('error', (error) => {
      this.transport.rejectPendingResponses('Websocket error');
      if (error.message.includes('Failed to connect')) {
        throw new Error(
          'OGI Addon Server is not running/is unreachable. Please start the server and try again.'
        );
      }
      console.error('An error occurred:', error);
    });

    this.socket.on('close', (code, reason) => {
      this.transport.rejectPendingResponses('Websocket closed');
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

  private async userInputAsked<
    U extends Record<string, string | number | boolean>,
  >(
    configBuilt: ConfigurationBuilder<U>,
    name: string,
    description: string
  ): Promise<U> {
    const config = configBuilt.build(false);
    const response = await this.transport.send(
      {
        event: 'input-asked',
        args: {
          config,
          name,
          description,
        },
      } as WebsocketMessageClient,
      true
    );
    return response.args as U;
  }

  /**
   * Registers the message receiver for the socket. This is used to receive messages from the server and handle them.
   */
  private registerMessageReceiver() {
    this.socket.on('message', async (raw: RawData) => {
      const message = this.transport.parseMessage(this.normalizeRawData(raw));
      if (!message) {
        return;
      }
      if (this.transport.resolveIncomingResponse(message)) {
        return;
      }
      switch (message.event) {
        case 'config-update':
          const result = this.addon.config.updateConfig(
            message.args as DefiniteConfig
          );
          if (!result[0]) {
            this.respondToMessage(
              message.id!!,
              {
                success: false,
                error: result[1],
              },
              undefined
            );
          } else {
            this.respondToMessage(message.id!!, { success: true }, undefined);
          }
          break;
        case 'search':
          await this.handleEventWithResponse<SearchResult[]>(message, (event) =>
            this.eventEmitter.emit('search', message.args, event)
          );
          break;
        case 'setup': {
          let setupEvent = new EventResponse<SetupEventResponse>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description)
          );
          this.eventEmitter.emit('setup', message.args, setupEvent);
          const interval = setInterval(() => {
            if (setupEvent.resolved) {
              clearInterval(interval);
              return;
            }
            this.send('defer-update', {
              logs: setupEvent.logs,
              deferID:
                message.args as ClientToServerEventArgs['defer-update']['deferID'],
              progress: setupEvent.progress,
              failed: setupEvent.failed,
            } as ClientToServerEventArgs['defer-update']);
          }, 100);
          const setupResult = await this.waitForEventToRespond(setupEvent);
          this.respondToMessage(message.id!!, setupResult.data, setupEvent);
          break;
        }
        case 'library-search':
          await this.handleEventWithResponse<BasicLibraryInfo[]>(
            message,
            (event) =>
              this.eventEmitter.emit('library-search', message.args, event)
          );
          break;
        case 'game-details':
          await this.handleEventWithResponse<StoreData | undefined>(
            message,
            (event) =>
              this.eventEmitter.emit('game-details', message.args, event),
            {
              requireListener: 'game-details',
              noListenerError: 'No event listener for game-details',
            }
          );
          break;
        case 'check-for-updates':
          await this.handleEventWithResponse<
            { available: true; version: string } | { available: false }
          >(message, (event) =>
            this.eventEmitter.emit('check-for-updates', message.args, event)
          );
          break;
        case 'request-dl':
          let requestDLEvent = new EventResponse<SearchResult>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description)
          );
          if (this.eventEmitter.listenerCount('request-dl') === 0) {
            this.respondToMessage(
              message.id!!,
              {
                error: 'No event listener for request-dl',
              },
              requestDLEvent
            );
            break;
          }
          const { appID, info } = message.args as {
            appID: number;
            info: SearchResult;
          };
          this.eventEmitter.emit(
            'request-dl',
            appID,
            info,
            requestDLEvent as EventResponse<SearchResult>
          );
          const requestDLResult =
            await this.waitForEventToRespond(requestDLEvent);
          if (requestDLEvent.failed) {
            this.respondToMessage(message.id!!, undefined, requestDLEvent);
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
          this.respondToMessage(
            message.id!!,
            requestDLResult.data,
            requestDLEvent
          );
          break;
        case 'catalog':
          await this.handleEventWithResponseNoInput<CatalogResponse>(
            message,
            (event) => this.eventEmitter.emit('catalog', event)
          );
          break;
        case 'task-run': {
          let taskRunEvent = new EventResponse<void>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description)
          );
          const args = message.args as TaskRunMessageArgs;

          // Check for taskName: first from args directly (from SearchResult), then from manifest.__taskName (for ActionOption)
          const taskName =
            args.taskName && typeof args.taskName === 'string'
              ? args.taskName
              : args.manifest && typeof args.manifest === 'object'
                ? args.manifest.__taskName
                : undefined;

          if (
            taskName &&
            typeof taskName === 'string' &&
            this.addon.hasTaskHandler(taskName)
          ) {
            // Use the registered task handler
            const handler = this.addon.getTaskHandler(taskName)!;
            const task = new Task(taskRunEvent);
            try {
              const interval = setInterval(() => {
                if (taskRunEvent.resolved) {
                  clearInterval(interval);
                  return;
                }
                this.send('defer-update', {
                  logs: taskRunEvent.logs,
                  deferID: args.deferID ?? '',
                  progress: taskRunEvent.progress,
                  failed: taskRunEvent.failed,
                } as ClientToServerEventArgs['defer-update']);
              }, 100);
              const result = handler(task, {
                manifest: args.manifest || {},
                downloadPath: args.downloadPath || '',
                name: args.name || '',
                libraryInfo: args.libraryInfo,
              });
              // If handler returns a promise, wait for it
              if (result instanceof Promise) {
                await result;
              }

              clearInterval(interval);
            } catch (error) {
              taskRunEvent.fail(
                error instanceof Error ? error.message : String(error)
              );
            }
          } else {
            // No handler found - fail the task
            taskRunEvent.fail(
              taskName
                ? `No task handler registered for task name: ${taskName}`
                : 'No task name provided'
            );
          }

          const taskRunResult = await this.waitForEventToRespond(taskRunEvent);
          this.respondToMessage(message.id!!, taskRunResult.data, taskRunEvent);
          break;
        }
        case 'launch-app':
          await this.handleEventWithResponse<void>(message, (event) =>
            this.eventEmitter.emit('launch-app', message.args, event)
          );
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

  /**
   * Common flow for events that use EventResponse with userInputAsked: create event, emit via callback, wait, respond.
   * If options.requireListener is set and that event has no listeners, responds with options.noListenerError and returns.
   */
  private async handleEventWithResponse<T>(
    message: WebsocketMessageServer,
    emit: (event: EventResponse<T>) => void,
    options?: { requireListener: string; noListenerError: string }
  ): Promise<void> {
    const event = new EventResponse<T>((screen, name, description) =>
      this.userInputAsked(screen, name, description)
    );
    if (
      options &&
      this.eventEmitter.listenerCount(options.requireListener) === 0
    ) {
      this.respondToMessage(
        message.id!!,
        { error: options.noListenerError },
        event
      );
      return;
    }
    emit(event);
    const result = await this.waitForEventToRespond(event);
    this.respondToMessage(message.id!!, result.data, event);
  }

  /**
   * Same as handleEventWithResponse but for events that don't need userInputAsked (e.g. catalog).
   */
  private async handleEventWithResponseNoInput<T>(
    message: WebsocketMessageServer,
    emit: (event: EventResponse<T>) => void
  ): Promise<void> {
    const event = new EventResponse<T>();
    emit(event);
    const result = await this.waitForEventToRespond(event);
    this.respondToMessage(message.id!!, result.data, event);
  }

  public respondToMessage(
    messageID: string,
    response: any,
    originalEvent: EventResponse<any> | undefined
  ) {
    void this.transport.send(
      {
        event: 'response',
        id: messageID,
        args: response,
        statusError: originalEvent ? originalEvent.failed : undefined,
      } as WebsocketMessageClient,
      false
    );
    console.log('dispatched response to ' + messageID);
  }

  public async requestResponse<T>(
    event: OGIAddonClientSentEvent,
    args: ClientToServerEventArgs[OGIAddonClientSentEvent]
  ): Promise<T> {
    const response = await this.transport.send(
      { event, args } as WebsocketMessageClient,
      true
    );
    return response.args as T;
  }

  public send(
    event: OGIAddonClientSentEvent,
    args: ClientToServerEventArgs[OGIAddonClientSentEvent]
  ): string {
    const id = randomMessageId();
    void this.transport.send(
      {
        event,
        args,
        id,
      } as WebsocketMessageClient,
      false
    );
    return id;
  }

  public close() {
    this.socket.close();
  }
}
