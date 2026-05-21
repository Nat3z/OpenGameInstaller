import { WebSocket } from 'ws';
import { EventResponseSocket, randomMessageId } from '@ogi-sdk/connect';
import type {
  AddonClientToServerEventArgs,
  AddonClientToServerEventName,
  AddonClientToServerWebsocketMessage,
  AddonNotificationMessage,
  AddonProtocolEventListenerTypes,
  AddonSDKLifecycleEventListenerTypes,
  AddonServerToClientWebsocketMessage,
  BasicLibraryInfo,
  CatalogResponse,
  LibraryInfo,
  OGIAddonConfiguration,
  OGIAddonSDKEventListener,
  SearchResult,
  SetupResponse,
  StoreData,
  AddonTaskRunEventArgs,
} from '@ogi-sdk/connect';
import events from 'node:events';
import { ConfigurationBuilder } from './config/ConfigurationBuilder';
import { Configuration, DefiniteConfig } from './config/Configuration';
import EventResponse from './EventResponse';
import Fuse, { IFuseOptions } from 'fuse.js';

export { ConfigurationBuilder, Configuration, EventResponse };
export { extraction };
const defaultPort = 7654;
import pjson from '../package.json';
import { z } from 'zod';
import { extraction } from './extraction';
export const VERSION = pjson.version;

export type {
  AddonClientToServerEventArgs,
  AddonClientToServerEventName,
  AddonClientToServerWebsocketMessage,
  AddonNotificationMessage,
  AddonServerToClientEventName,
  AddonServerToClientWebsocketMessage,
  BasicLibraryInfo,
  CatalogCarouselItem,
  CatalogResponse,
  CatalogSection,
  CatalogWithCarousel,
  ConfigurationFile,
  ConfigurationOptionType,
  ConfigurationOptionWire,
  LibraryInfo,
  OGIAddonConfiguration,
  OGIAddonSDKEventListener,
  SearchResult,
  SetupResponse,
  SetupEventResponse,
  StoreData,
  UmuId,
  SetupCommandData,
  AddonProtocolEventListenerTypes,
  AddonSDKLifecycleEventListenerTypes,
  AddonServerHostEventListeners,
  AddonServerHostEventName,
  AddonServerLifecycleEvent,
} from '@ogi-sdk/connect';

/** @deprecated Use {@link AddonNotificationMessage}. */
export type Notification = AddonNotificationMessage;

/**
 * Addon SDK listener signatures. Protocol commands come from `addonProtocol` in
 * `@ogi-sdk/connect`; lifecycle and builder-specific hooks are merged below.
 */
export type EventListenerTypes = AddonSDKLifecycleEventListenerTypes<
  EventResponse<unknown>
> &
  AddonProtocolEventListenerTypes<
    EventResponse<unknown>,
    'authenticate' | 'configure' | 'catalog'
  > & {
    authenticate: (config: unknown) => void;
    configure: (config: ConfigurationBuilder) => ConfigurationBuilder;
    catalog: (event: Omit<EventResponse<CatalogResponse>, 'askForInput'>) => void;
  };

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
  private eventsAvailable: OGIAddonSDKEventListener[] = [];
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
   * @param event {OGIAddonSDKEventListener}
   * @param listener {EventListenerTypes[OGIAddonSDKEventListener]}
   */
  public on<T extends OGIAddonSDKEventListener>(
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

  public emit<T extends OGIAddonSDKEventListener>(
    event: T,
    ...args: Parameters<EventListenerTypes[T]>
  ) {
    this.eventEmitter.emit(event, ...args);
  }

  /**
   * Notify the client using a notification. Provide the type of notification, the message, and an ID.
   * @param notification {Notification}
   */
  public notify(notification: AddonNotificationMessage) {
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
export const ZodLibraryInfo: z.ZodType<LibraryInfo> = z.object({
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

export type { AddonTaskRunEventArgs as TaskRunMessageArgs } from '@ogi-sdk/connect';

class OGIAddonWSListener {
  private socket: WebSocket;
  private transport: EventResponseSocket<
    AddonServerToClientWebsocketMessage,
    AddonClientToServerWebsocketMessage
  >;
  public eventEmitter: events.EventEmitter;
  public addon: OGIAddon;

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
      this.send('authenticate' as AddonClientToServerEventName, {
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
      const unsubscribeConfigListener = this.transport.on(
        'config-update',
        () => {
          console.log('Config update received');
          unsubscribeConfigListener();
          this.eventEmitter.emit(
            'connect',
            new EventResponse<void>((screen, name, description) => {
              return this.userInputAsked(screen, name, description);
            })
          );
        }
      );
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
      } as AddonClientToServerWebsocketMessage,
      { expectResponse: true }
    );
    return response.args as U;
  }

  /**
   * Registers the message receiver for the socket. This is used to receive messages from the server and handle them.
   */
  private registerMessageReceiver() {
    const events: AddonServerToClientWebsocketMessage['event'][] = [
      'config-update',
      'search',
      'setup',
      'library-search',
      'game-details',
      'check-for-updates',
      'request-dl',
      'catalog',
      'task-run',
      'launch-app',
    ];

    for (const event of events) {
      this.transport.on(event, async (message) => {
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
            await this.handleEventWithResponse<SearchResult[]>(
              message,
              (event) => this.eventEmitter.emit('search', message.args, event)
            );
            break;
          case 'setup': {
            let setupEvent = new EventResponse<SetupResponse>(
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
                  message.args as AddonClientToServerEventArgs['defer-update']['deferID'],
                progress: setupEvent.progress,
                failed: setupEvent.failed,
              } as AddonClientToServerEventArgs['defer-update']);
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
            const args = message.args as AddonTaskRunEventArgs;

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
                  } as AddonClientToServerEventArgs['defer-update']);
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

            const taskRunResult =
              await this.waitForEventToRespond(taskRunEvent);
            this.respondToMessage(
              message.id!!,
              taskRunResult.data,
              taskRunEvent
            );
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
    message: AddonServerToClientWebsocketMessage,
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
    message: AddonServerToClientWebsocketMessage,
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
      } as AddonClientToServerWebsocketMessage,
      { expectResponse: false }
    );
    console.log('dispatched response to ' + messageID);
  }

  public async requestResponse<T>(
    event: AddonClientToServerEventName,
    args: AddonClientToServerEventArgs[AddonClientToServerEventName]
  ): Promise<T> {
    const response = await this.transport.send(
      { event, args } as AddonClientToServerWebsocketMessage,
      { expectResponse: true }
    );
    return response.args as T;
  }

  public send(
    event: AddonClientToServerEventName,
    args: AddonClientToServerEventArgs[AddonClientToServerEventName]
  ): string {
    const id = randomMessageId();
    void this.transport.send(
      {
        event,
        args,
        id,
      } as AddonClientToServerWebsocketMessage,
      { expectResponse: false }
    );
    return id;
  }

  public close() {
    this.socket.close();
  }
}
