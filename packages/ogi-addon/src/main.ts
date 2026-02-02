import ws, { WebSocket } from 'ws';
import events from 'node:events';
import { ConfigurationBuilder } from './config/ConfigurationBuilder';
import type { ConfigurationFile } from './config/ConfigurationBuilder';
import { Configuration } from './config/Configuration';
import EventResponse from './EventResponse';
import type { SearchResult } from './SearchEngine';
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
  | 'check-for-updates'
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
  | 'search-app-name'
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
  | 'check-for-updates'
  | 'task-run'
  | 'game-details'
  | 'request-dl'
  | 'catalog';
export { ConfigurationBuilder, Configuration, EventResponse };
export type { SearchResult };
const defaultPort = 7654;
import pjson from '../package.json';
import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import { z } from 'zod';
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
  'input-asked': ConfigurationBuilder<
    Record<string, string | number | boolean>
  >;
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
   * Optional cloud save paths suggested by the addon. Paths can be relative to
   * the game cwd or absolute. OGI can copy these into the local cloud-save
   * config so the user sees them pre-filled.
   */
  cloudSavePaths?: { name: string; path: string }[];
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
export interface WebsocketMessageClient {
  event: OGIAddonClientSentEvent;
  id?: string;
  args: any;
  statusError?: string;
}
export interface WebsocketMessageServer {
  event: OGIAddonServerSentEvent;
  id?: string;
  args: any;
  statusError?: string;
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
    const id = this.addonWSListener.send('get-app-details', {
      appID,
      storefront,
    });
    return await this.addonWSListener.waitForResponseFromServer<
      StoreData | undefined
    >(id);
  }

  public async searchGame(query: string, storefront: string) {
    const id = this.addonWSListener.send('search-app-name', {
      query,
      storefront,
    });
    return await this.addonWSListener.waitForResponseFromServer<
      BasicLibraryInfo[]
    >(id);
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
   * @param type {'unrar' | 'unzip'}
   * @returns {Promise<void>}
   */
  public async extractFile(
    path: string,
    outputPath: string,
    type: 'unrar' | 'unzip'
  ) {
    return new Promise<void>((resolve, reject) => {
      // Ensure outputPath exists
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
      }

      if (type === 'unzip') {
        // Prefer 7-Zip on Windows, unzip on Linux/Mac
        if (process.platform === 'win32') {
          // 7-Zip path (default install location)
          const s7ZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';
          exec(
            `${s7ZipPath} x "${path}" -o"${outputPath}"`,
            (err: any, stdout: any, stderr: any) => {
              if (err) {
                console.error(err);
                console.log(stderr);
                reject(new Error('Failed to extract ZIP file'));
                return;
              }
              console.log(stdout);
              console.log(stderr);
              resolve();
            }
          );
        } else {
          // Use unzip on Linux/Mac
          const unzipProcess = spawn(
            'unzip',
            [
              '-o', // overwrite files without prompting
              path,
              '-d', // specify output directory
              outputPath,
            ],
            {
              env: {
                ...process.env,
                UNZIP_DISABLE_ZIPBOMB_DETECTION: 'TRUE',
              },
            }
          );

          unzipProcess.stdout.on('data', (data: Buffer) => {
            console.log(`[unzip stdout]: ${data}`);
          });

          unzipProcess.stderr.on('data', (data: Buffer) => {
            console.error(`[unzip stderr]: ${data}`);
          });

          unzipProcess.on('close', (code: number) => {
            if (code !== 0) {
              console.error(`unzip process exited with code ${code}`);
              reject(new Error('Failed to extract ZIP file'));
              return;
            }
            resolve();
          });
        }
      } else if (type === 'unrar') {
        if (process.platform === 'win32') {
          // 7-Zip path (default install location)
          const s7ZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';
          exec(
            `${s7ZipPath} x "${path}" -o"${outputPath}"`,
            (err: any, stdout: any, stderr: any) => {
              if (err) {
                console.error(err);
                console.log(stderr);
                reject(new Error('Failed to extract RAR file'));
                return;
              }
              console.log(stdout);
              console.log(stderr);
              resolve();
            }
          );
        } else {
          // Use unrar on Linux/Mac
          const unrarProcess = spawn('unrar', ['x', '-y', path, outputPath]);

          unrarProcess.stdout.on('data', (data: Buffer) => {
            console.log(`[unrar stdout]: ${data}`);
          });

          unrarProcess.stderr.on('data', (data: Buffer) => {
            console.error(`[unrar stderr]: ${data}`);
          });

          unrarProcess.on('close', (code: number) => {
            if (code !== 0) {
              console.error(`unrar process exited with code ${code}`);
              reject(new Error('Failed to extract RAR file'));
              return;
            }
            resolve();
          });
        }
      } else {
        reject(new Error('Unknown extraction type'));
      }
    });
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
  capsuleImage: z.string(),
  storefront: z.string(),
  addonsource: z.string(),
  coverImage: z.string(),
  titleImage: z.string().optional(),
});
export type LibraryInfo = z.infer<typeof ZodLibraryInfo>;
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

      // send a configuration request
      let configBuilder = new ConfigurationBuilder();
      this.eventEmitter.emit('configure', configBuilder);
      this.send('configure', configBuilder.build(false));
      this.addon.config = new Configuration(configBuilder.build(true));

      // wait for the config-update to be received then send connect
      const configListener = (event: ws.MessageEvent) => {
        if (event === undefined) return;
        // event can be a Buffer, string, ArrayBuffer, or Buffer[]
        let data: string;
        if (typeof event === 'string') {
          data = event;
        } else if (event instanceof Buffer) {
          data = event.toString();
        } else if (event && typeof (event as any).data === 'string') {
          data = (event as any).data;
        } else if (event && (event as any).data instanceof Buffer) {
          data = (event as any).data.toString();
        } else {
          // fallback for other types
          data = event.toString();
        }
        const message: WebsocketMessageServer = JSON.parse(data);
        if (message.event === 'config-update') {
          console.log('Config update received');
          this.socket.off('message', configListener);
          this.eventEmitter.emit(
            'connect',
            new EventResponse<void>((screen, name, description) => {
              return this.userInputAsked(
                screen,
                name,
                description,
                this.socket
              );
            })
          );
        }
      };
      this.socket.on('message', configListener);
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

  private async userInputAsked<
    U extends Record<string, string | number | boolean>,
  >(
    configBuilt: ConfigurationBuilder<U>,
    name: string,
    description: string,
    socket: WebSocket
  ): Promise<U> {
    const config = configBuilt.build(false);
    const id = Math.random().toString(36).substring(7);
    if (!socket) {
      throw new Error('Socket is not connected');
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
    return await this.waitForResponseFromServer<U>(id);
  }

  private registerMessageReceiver() {
    this.socket.on('message', async (data: string) => {
      const message: WebsocketMessageServer = JSON.parse(data);
      switch (message.event) {
        case 'config-update':
          const result = this.addon.config.updateConfig(message.args);
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
          let searchResultEvent = new EventResponse<SearchResult[]>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );
          this.eventEmitter.emit('search', message.args, searchResultEvent);
          const searchResult =
            await this.waitForEventToRespond(searchResultEvent);
          this.respondToMessage(
            message.id!!,
            searchResult.data,
            searchResultEvent
          );
          break;
        case 'setup': {
          let setupEvent = new EventResponse<SetupEventResponse>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );
          this.eventEmitter.emit('setup', message.args, setupEvent);
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
          this.respondToMessage(message.id!!, setupResult.data, setupEvent);
          break;
        }
        case 'library-search':
          let librarySearchEvent = new EventResponse<BasicLibraryInfo[]>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );
          this.eventEmitter.emit(
            'library-search',
            message.args,
            librarySearchEvent
          );
          const librarySearchResult =
            await this.waitForEventToRespond(librarySearchEvent);
          this.respondToMessage(
            message.id!!,
            librarySearchResult.data,
            librarySearchEvent
          );
          break;
        case 'game-details':
          let gameDetailsEvent = new EventResponse<StoreData | undefined>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );
          if (this.eventEmitter.listenerCount('game-details') === 0) {
            this.respondToMessage(
              message.id!!,
              {
                error: 'No event listener for game-details',
              },
              gameDetailsEvent
            );
            break;
          }
          this.eventEmitter.emit(
            'game-details',
            message.args,
            gameDetailsEvent
          );
          const gameDetailsResult =
            await this.waitForEventToRespond(gameDetailsEvent);
          this.respondToMessage(
            message.id!!,
            gameDetailsResult.data,
            gameDetailsEvent
          );
          break;
        case 'check-for-updates':
          let checkForUpdatesEvent = new EventResponse<
            | {
                available: true;
                version: string;
              }
            | {
                available: false;
              }
          >((screen, name, description) =>
            this.userInputAsked(screen, name, description, this.socket)
          );
          this.eventEmitter.emit(
            'check-for-updates',
            message.args,
            checkForUpdatesEvent
          );
          const checkForUpdatesResult =
            await this.waitForEventToRespond(checkForUpdatesEvent);
          this.respondToMessage(
            message.id!!,
            checkForUpdatesResult.data,
            checkForUpdatesEvent
          );
          break;
        case 'request-dl':
          let requestDLEvent = new EventResponse<SearchResult>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
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
          this.eventEmitter.emit(
            'request-dl',
            message.args.appID,
            message.args.info,
            requestDLEvent
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
          let catalogEvent = new EventResponse<{
            [key: string]: {
              name: string;
              description: string;
              listings: BasicLibraryInfo[];
            };
          }>();
          this.eventEmitter.emit('catalog', catalogEvent);
          const catalogResult = await this.waitForEventToRespond(catalogEvent);
          this.respondToMessage(message.id!!, catalogResult.data, catalogEvent);
          break;
        case 'task-run': {
          let taskRunEvent = new EventResponse<void>(
            (screen, name, description) =>
              this.userInputAsked(screen, name, description, this.socket)
          );

          // Check for taskName: first from args directly (from SearchResult), then from manifest.__taskName (for ActionOption)
          const taskName =
            message.args.taskName && typeof message.args.taskName === 'string'
              ? message.args.taskName
              : message.args.manifest &&
                  typeof message.args.manifest === 'object'
                ? (message.args.manifest as Record<string, unknown>).__taskName
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
                  deferID: message.args.deferID,
                  progress: taskRunEvent.progress,
                  failed: taskRunEvent.failed,
                } as ClientSentEventTypes['defer-update']);
              }, 100);
              const result = handler(task, {
                manifest: message.args.manifest || {},
                downloadPath: message.args.downloadPath || '',
                name: message.args.name || '',
                libraryInfo: message.args.libraryInfo,
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

  public respondToMessage(
    messageID: string,
    response: any,
    originalEvent: EventResponse<any> | undefined
  ) {
    this.socket.send(
      JSON.stringify({
        event: 'response',
        id: messageID,
        args: response,
        statusError: originalEvent ? originalEvent.failed : undefined,
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
