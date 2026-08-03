import events from 'node:events';
import {
  AddonError,
  formatError,
  NetworkError,
  ValidationError,
} from '@ogi/errors';
import type {
  AddonClientToServerEventArgs,
  AddonClientToServerEventName,
  AddonClientToServerWebsocketMessage,
  AddonNotificationMessage,
  AddonProtocolEventListenerTypes,
  AddonSDKLifecycleEventListenerTypes,
  AddonServerToClientWebsocketMessage,
  AddonTaskRunEventArgs,
  BasicLibraryInfo,
  CatalogResponse,
  LibraryInfo,
  OGIAddonConfiguration,
  OGIAddonSDKEventListener,
  SearchResult,
  SetupResponse,
  StoreData,
} from '@ogi-sdk/connect';
import { EventResponseSocket, randomMessageId } from '@ogi-sdk/connect';
import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import Fuse, { IFuseOptions } from 'fuse.js';
import { Configuration, DefiniteConfig } from './config/Configuration';
import { ConfigurationBuilder } from './config/ConfigurationBuilder';
import EventResponse from './EventResponse';

export { Configuration, ConfigurationBuilder, EventResponse, extraction };

const defaultPort = 7654;

import pjson from '../package.json';
import { extraction } from './extraction';
export const VERSION = pjson.version;

export type {
  AddonClientToServerEventArgs,
  AddonClientToServerEventName,
  AddonClientToServerWebsocketMessage,
  AddonNotificationMessage,
  AddonProtocolEventListenerTypes,
  AddonSDKLifecycleEventListenerTypes,
  AddonServerHostEventListeners,
  AddonServerHostEventName,
  AddonServerLifecycleEvent,
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
  SetupCommandData,
  SetupEventResponse,
  SetupResponse,
  StoreData,
  UmuId,
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
    catalog: (
      event: Omit<EventResponse<CatalogResponse>, 'askForInput'>
    ) => void;
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
  private readonly runtime = ManagedRuntime.make(Layer.empty);
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
    ) => Effect.Effect<void, unknown> | Promise<void> | void
  > = new Map();

  constructor(addonInfo: OGIAddonConfiguration) {
    this.addonInfo = addonInfo;
    // The constructor remains the synchronous compatibility boundary for addons.
    this.addonWSListener = this.runtime.runSync(
      OGIAddonWSListener.make(this, this.eventEmitter, (effect) =>
        this.runBackground(effect)
      )
    );
    this.runBackground(this.addonWSListener.run());
  }

  private runBackground(effect: Effect.Effect<void, unknown>): void {
    this.runtime.runFork(
      effect.pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => console.error(formatError(error)))
        )
      )
    );
  }

  private runPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    return this.runtime.runPromise(effect);
  }

  public closeEffect(): Effect.Effect<void, NetworkError> {
    return this.addonWSListener.close();
  }

  /** Promise compatibility adapter that also releases the managed runtime. */
  public close(): Promise<void> {
    return this.runPromise(this.closeEffect()).finally(() =>
      this.runtime.dispose()
    );
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
    if (this.addonWSListener.isConnected()) {
      this.runBackground(this.sendEventsAvailable());
    }
  }

  public emit<T extends OGIAddonSDKEventListener>(
    event: T,
    ...args: Parameters<EventListenerTypes[T]>
  ): boolean {
    return this.eventEmitter.emit(event, ...args);
  }

  public sendEventsAvailable(): Effect.Effect<
    void,
    NetworkError | ValidationError
  > {
    return this.addonWSListener
      .send('flag', {
        flag: 'events-available',
        value: this.eventsAvailable,
      })
      .pipe(Effect.asVoid);
  }

  public notifyEffect(
    notification: AddonNotificationMessage
  ): Effect.Effect<void, NetworkError | ValidationError> {
    return this.addonWSListener
      .send('notification', notification)
      .pipe(Effect.asVoid);
  }

  /** Compatibility adapter for the existing fire-and-forget API. */
  public notify(notification: AddonNotificationMessage): void {
    this.runBackground(this.notifyEffect(notification));
  }

  /**
   * Get the app details for a given appID and storefront.
   * @param appID {number}
   * @param storefront {string}
   * @returns {Promise<StoreData>}
   */
  public getAppDetailsEffect(
    appID: number,
    storefront: string
  ): Effect.Effect<StoreData | undefined, NetworkError | ValidationError> {
    return this.addonWSListener.requestResponse<StoreData | undefined>(
      'get-app-details',
      { appID, storefront }
    );
  }

  /** Promise compatibility adapter. */
  public getAppDetails(
    appID: number,
    storefront: string
  ): Promise<StoreData | undefined> {
    return this.runPromise(this.getAppDetailsEffect(appID, storefront));
  }

  public searchGameEffect(
    query: string,
    storefront: string
  ): Effect.Effect<BasicLibraryInfo[], NetworkError | ValidationError> {
    return this.addonWSListener.requestResponse<BasicLibraryInfo[]>(
      'search-app-name',
      { query, storefront }
    );
  }

  /** Promise compatibility adapter. */
  public searchGame(
    query: string,
    storefront: string
  ): Promise<BasicLibraryInfo[]> {
    return this.runPromise(this.searchGameEffect(query, storefront));
  }

  /**
   * Notify the OGI Addon Server that you are performing a background task. This can be used to help users understand what is happening in the background.
   * @returns {Promise<Task>} A Task instance for managing the background task.
   */
  public taskEffect(): Effect.Effect<Task, NetworkError | ValidationError> {
    return Effect.gen(this, function* () {
      const id = yield* randomMessageId();
      const progress = 0;
      const logs: string[] = [];
      const task = new Task(
        this.addonWSListener,
        id,
        progress,
        logs,
        (effect) => this.runBackground(effect)
      );
      yield* this.addonWSListener.send('task-update', {
        id,
        progress,
        logs,
        finished: false,
        failed: undefined,
      });
      return task;
    });
  }

  /** Promise compatibility adapter. */
  public task(): Promise<Task> {
    return this.runPromise(this.taskEffect());
  }

  /**
   * Register a task handler for a specific task name. The task name should match the taskName field in SearchResult or ActionOption.
   * @param taskName {string} The name of the task (should match taskName in SearchResult or ActionOption.setTaskName()).
   * @param handler {(task: Task, data: { manifest: Record<string, unknown>; downloadPath: string; name: string; libraryInfo: LibraryInfo }) => Effect.Effect<void, unknown> | Promise<void> | void} The handler function.
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
    ) => Effect.Effect<void, unknown> | Promise<void> | void
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
      ) => Effect.Effect<void, unknown> | Promise<void> | void)
    | undefined {
    return this.taskHandlers.get(taskName);
  }

  /**
   * Extract a file using 7-Zip on Windows, unzip on Linux/Mac.
   * @param path {string}
   * @param outputPath {string}
   * @returns {Promise<void>}
   */
  public extractFile(path: string, outputPath: string) {
    return extraction(path, outputPath);
  }
}

/**
 * A unified task API for both server-initiated tasks (via onTask handlers)
 * and addon-initiated background tasks (via addon.task()).
 * Provides chainable methods for logging, progress updates, and completion.
 */
type EffectScheduler = (effect: Effect.Effect<void, unknown>) => void;

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
  private readonly schedule?: EffectScheduler;

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
    logs: string[],
    schedule?: EffectScheduler
  );

  constructor(
    eventOrWs: EventResponse<void> | OGIAddonWSListener,
    id?: string,
    progress?: number,
    logs?: string[],
    schedule?: EffectScheduler
  ) {
    this.schedule = schedule;
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
  logEffect(
    message: string
  ): Effect.Effect<void, NetworkError | ValidationError> {
    return Effect.sync(() => {
      if (this.event) this.event.log(message);
      else this.logs.push(message);
    }).pipe(Effect.zipRight(this.update()));
  }

  log(message: string): this {
    if (this.event) this.event.log(message);
    else {
      this.logs.push(message);
      this.schedule?.(this.update());
    }
    return this;
  }

  /**
   * Set the progress of the task (0-100). Returns this for chaining.
   * @param progress {number} The progress value (0-100).
   */
  setProgressEffect(
    progress: number
  ): Effect.Effect<void, NetworkError | ValidationError> {
    return Effect.sync(() => {
      if (this.event) this.event.progress = progress;
      else this.progress = progress;
    }).pipe(Effect.zipRight(this.update()));
  }

  setProgress(progress: number): this {
    if (this.event) this.event.progress = progress;
    else {
      this.progress = progress;
      this.schedule?.(this.update());
    }
    return this;
  }

  /**
   * Complete the task successfully.
   */
  completeEffect(): Effect.Effect<void, NetworkError | ValidationError> {
    return Effect.sync(() => {
      if (this.event) this.event.complete();
      else this.finished = true;
    }).pipe(Effect.zipRight(this.update()));
  }

  complete(): void {
    if (this.event) this.event.complete();
    else {
      this.finished = true;
      this.schedule?.(this.update());
    }
  }

  /**
   * Fail the task with an error message.
   * @param message {string} The error message.
   */
  failEffect(
    message: string
  ): Effect.Effect<void, NetworkError | ValidationError> {
    return Effect.sync(() => {
      if (this.event) this.event.fail(message);
      else this.failed = message;
    }).pipe(Effect.zipRight(this.update()));
  }

  fail(message: string): void {
    if (this.event) this.event.fail(message);
    else {
      this.failed = message;
      this.schedule?.(this.update());
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
  askForInputEffect<U extends Record<string, string | number | boolean>>(
    name: string,
    description: string,
    screen: ConfigurationBuilder<U>
  ): Effect.Effect<U, AddonError> {
    if (!this.event) {
      return Effect.fail(
        new AddonError({
          message:
            'askForInput() is only available for EventResponse-based tasks (onTask handlers)',
        })
      );
    }
    return this.event.askForInputEffect(name, description, screen);
  }

  /** Promise compatibility adapter. */
  askForInput<U extends Record<string, string | number | boolean>>(
    name: string,
    description: string,
    screen: ConfigurationBuilder<U>
  ): Promise<U> {
    return Effect.runPromise(this.askForInputEffect(name, description, screen));
  }

  /**
   * Update the task state (for WebSocket-based tasks only).
   * Called automatically when using log(), setProgress(), complete(), or fail().
   */
  private update(): Effect.Effect<void, NetworkError | ValidationError> {
    if (!this.ws || this.id === undefined) return Effect.void;
    return this.ws
      .send('task-update', {
        id: this.id,
        progress: this.progress,
        logs: this.logs,
        finished: this.finished,
        failed: this.failed,
      })
      .pipe(Effect.asVoid);
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
export const LibraryInfoSchema: Schema.Schema<LibraryInfo> = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  cwd: Schema.String,
  appID: Schema.Number,
  launchExecutable: Schema.String,
  launchArguments: Schema.optional(Schema.String),
  launchEnv: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String })
  ),
  capsuleImage: Schema.String,
  storefront: Schema.String,
  addonsource: Schema.String,
  coverImage: Schema.String,
  titleImage: Schema.optional(Schema.String),
  umu: Schema.optional(
    Schema.Struct({
      umuId: Schema.String.pipe(Schema.pattern(/^(steam|umu):\S+$/)),
      dllOverrides: Schema.optional(
        Schema.mutable(Schema.Array(Schema.String))
      ),
      protonVersion: Schema.optional(Schema.String),
      store: Schema.optional(Schema.String),
      winePrefixPath: Schema.optional(Schema.String),
      steamShortcutId: Schema.optional(Schema.Number),
      steamShortcutReaddId: Schema.optional(Schema.Number),
      steamShortcutLegacyExecutable: Schema.optional(Schema.String),
      steamShortcutLegacyName: Schema.optional(Schema.String),
    })
  ),
  redistributables: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          path: Schema.String,
        })
      )
    )
  ),
});

/** @deprecated Use LibraryInfoSchema. */
export const ZodLibraryInfo = LibraryInfoSchema;

export type { AddonTaskRunEventArgs as TaskRunMessageArgs } from '@ogi-sdk/connect';

class OGIAddonWSListener {
  public readonly eventEmitter: events.EventEmitter;
  public readonly addon: OGIAddon;
  private configConnected = false;

  private constructor(
    addon: OGIAddon,
    eventEmitter: events.EventEmitter,
    private readonly socket: InstanceType<typeof globalThis.WebSocket>,
    private readonly transport: EventResponseSocket<
      AddonServerToClientWebsocketMessage,
      AddonClientToServerWebsocketMessage
    >,
    private readonly secret: string,
    private readonly schedule: EffectScheduler
  ) {
    this.addon = addon;
    this.eventEmitter = eventEmitter;
  }

  public static make(
    addon: OGIAddon,
    eventEmitter: events.EventEmitter,
    schedule: EffectScheduler
  ): Effect.Effect<OGIAddonWSListener, AddonError | NetworkError> {
    return Effect.gen(function* () {
      const secret = process.argv
        .find((arg) => arg.startsWith('--addonSecret='))
        ?.split('=')[1];
      if (!secret) {
        return yield* Effect.fail(
          new AddonError({
            message:
              'No secret provided. The addon must be started by the OGI Addon Server.',
            addonName: addon.addonInfo.name,
          })
        );
      }
      const port =
        process.argv
          .find((arg) => arg.startsWith('--addonPort='))
          ?.split('=')[1] ?? String(defaultPort);
      const WebSocketConstructor = globalThis.WebSocket;
      if (!WebSocketConstructor) {
        return yield* Effect.fail(
          new NetworkError({
            message: 'WebSocket is not available in this runtime',
          })
        );
      }
      const socket = yield* Effect.try({
        try: () => new WebSocketConstructor(`ws://localhost:${port}`),
        catch: (cause) =>
          new NetworkError({
            message: `Unable to create addon websocket: ${formatError(cause)}`,
          }),
      });
      const transport = yield* EventResponseSocket.make<
        AddonServerToClientWebsocketMessage,
        AddonClientToServerWebsocketMessage
      >(socket);
      const listener = new OGIAddonWSListener(
        addon,
        eventEmitter,
        socket,
        transport,
        secret,
        schedule
      );
      yield* listener.registerMessageReceiver();
      return listener;
    });
  }

  /** Runs websocket callbacks inside the addon's managed runtime and scope. */
  public run(): Effect.Effect<void> {
    const onOpen = (): void => this.schedule(this.onOpen());
    const onError = (event: Event): void => {
      this.schedule(
        this.transport.rejectPendingResponses('Websocket error').pipe(
          Effect.zipRight(
            Effect.sync(() => {
              const message =
                event instanceof ErrorEvent ? event.message : event.type;
              console.error(
                message.includes('Failed to connect')
                  ? 'OGI Addon Server is not running or is unreachable.'
                  : 'An addon websocket error occurred:',
                event
              );
            })
          )
        )
      );
    };
    const onClose = (event: CloseEvent): void => {
      this.schedule(
        this.transport.rejectPendingResponses('Websocket closed').pipe(
          Effect.zipRight(
            Effect.sync(() => {
              if (event.code === 1008) {
                console.error('Authentication failed:', event.reason);
                return;
              }
              this.eventEmitter.emit('disconnect', event.reason);
              this.eventEmitter.emit('exit');
            })
          )
        )
      );
    };

    return Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => {
          this.socket.addEventListener('open', onOpen);
          this.socket.addEventListener('error', onError);
          this.socket.addEventListener('close', onClose);
        }),
        () =>
          Effect.sync(() => {
            this.socket.removeEventListener('open', onOpen);
            this.socket.removeEventListener('error', onError);
            this.socket.removeEventListener('close', onClose);
          })
      ).pipe(Effect.zipRight(Effect.never))
    );
  }

  public isConnected(): boolean {
    return this.configConnected;
  }

  private onOpen(): Effect.Effect<void, NetworkError | ValidationError> {
    return Effect.gen(this, function* () {
      console.log('Connected to OGI Addon Server');
      console.log('OGI Addon Server Version:', VERSION);
      yield* this.send('authenticate', {
        ...this.addon.addonInfo,
        secret: this.secret,
        ogiVersion: VERSION,
      });
      const configBuilder = new ConfigurationBuilder();
      this.eventEmitter.emit('configure', configBuilder);
      yield* this.send('configure', configBuilder.build(false));
      this.addon.config = new Configuration(configBuilder.build(true));
    });
  }

  private userInputAsked<U extends Record<string, string | number | boolean>>(
    configBuilt: ConfigurationBuilder<U>,
    name: string,
    description: string
  ): Effect.Effect<U, NetworkError | ValidationError> {
    return this.transport
      .send(
        {
          event: 'input-asked',
          args: { config: configBuilt.build(false), name, description },
        } as AddonClientToServerWebsocketMessage,
        { expectResponse: true }
      )
      .pipe(Effect.map((response) => response.args as U));
  }

  private registerMessageReceiver(): Effect.Effect<void> {
    const protocolEvents: AddonServerToClientWebsocketMessage['event'][] = [
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
    return Effect.forEach(
      protocolEvents,
      (event) =>
        this.transport
          .on(event, (message) => this.handleMessage(message))
          .pipe(Effect.asVoid),
      { discard: true }
    );
  }

  private handleMessage(
    message: AddonServerToClientWebsocketMessage
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const id = message.id;
      if (!id) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Message ${message.event} is missing an ID`,
          })
        );
      }
      switch (message.event) {
        case 'config-update': {
          const result = yield* Effect.try({
            try: () =>
              this.addon.config.updateConfig(message.args as DefiniteConfig),
            catch: (cause) =>
              new ValidationError({
                message: `Invalid addon configuration: ${formatError(cause)}`,
              }),
          });
          yield* this.respondToMessage(
            id,
            result[0] ? { success: true } : { success: false, error: result[1] }
          );
          if (!this.configConnected) {
            this.configConnected = true;
            const connectEvent = this.makeEventResponse<void>();
            this.eventEmitter.emit('connect', connectEvent);
            this.schedule(this.runDeferredEffect(connectEvent));
            yield* this.addon.sendEventsAvailable();
          }
          return;
        }
        case 'search':
          return yield* this.handleEventWithResponse<SearchResult[]>(
            message,
            (event) => this.eventEmitter.emit('search', message.args, event)
          );
        case 'setup':
          return yield* this.handleSetup(message);
        case 'library-search':
          return yield* this.handleEventWithResponse<BasicLibraryInfo[]>(
            message,
            (event) =>
              this.eventEmitter.emit('library-search', message.args, event)
          );
        case 'game-details':
          return yield* this.handleEventWithResponse<StoreData | undefined>(
            message,
            (event) =>
              this.eventEmitter.emit('game-details', message.args, event),
            {
              requireListener: 'game-details',
              noListenerError: 'No event listener for game-details',
            }
          );
        case 'check-for-updates':
          return yield* this.handleEventWithResponse<
            { available: true; version: string } | { available: false }
          >(message, (event) =>
            this.eventEmitter.emit('check-for-updates', message.args, event)
          );
        case 'request-dl':
          return yield* this.handleRequestDownload(message);
        case 'catalog':
          return yield* this.handleEventWithResponseNoInput<CatalogResponse>(
            message,
            (event) => this.eventEmitter.emit('catalog', event)
          );
        case 'task-run':
          return yield* this.handleTaskRun(message);
        case 'launch-app':
          return yield* this.handleEventWithResponse<void>(message, (event) =>
            this.eventEmitter.emit('launch-app', message.args, event)
          );
      }
    }).pipe(
      Effect.catchAll((error) =>
        message.id
          ? this.respondToMessage(
              message.id,
              undefined,
              undefined,
              formatError(error)
            ).pipe(Effect.ignore)
          : Effect.sync(() => console.error(formatError(error)))
      )
    );
  }

  private makeEventResponse<T>(): EventResponse<T> {
    return new EventResponse<T>((screen, name, description) =>
      this.userInputAsked(screen, name, description).pipe(
        Effect.mapError(
          (error) => new AddonError({ message: formatError(error) })
        )
      )
    );
  }

  private runDeferredEffect(
    event: EventResponse<unknown>
  ): Effect.Effect<void> {
    return Effect.gen(function* () {
      while (!event.resolved) {
        const deferred = yield* event.awaitDeferredEffect();
        if (!deferred) return;
        yield* deferred.pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => event.fail(formatError(error)))
          )
        );
      }
    });
  }

  private reportDeferred(
    event: EventResponse<unknown>,
    deferID: string
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      while (!event.resolved) {
        yield* this.send('defer-update', {
          logs: event.logs,
          deferID,
          progress: event.progress,
          failed: event.failed,
        }).pipe(Effect.ignore);
        yield* Effect.sleep('100 millis');
      }
    });
  }

  private handleSetup(
    message: AddonServerToClientWebsocketMessage
  ): Effect.Effect<void, AddonError | NetworkError | ValidationError> {
    return Effect.scoped(
      Effect.gen(this, function* () {
        const event = this.makeEventResponse<SetupResponse>();
        this.eventEmitter.emit('setup', message.args, event);
        yield* Effect.forkScoped(this.runDeferredEffect(event));
        yield* Effect.forkScoped(this.reportDeferred(event, message.id!));
        const result = yield* this.waitForEventToRespond(event);
        yield* this.respondToMessage(message.id!, result.data, event);
      })
    );
  }

  private handleRequestDownload(
    message: AddonServerToClientWebsocketMessage
  ): Effect.Effect<void, AddonError | NetworkError | ValidationError> {
    return Effect.scoped(
      Effect.gen(this, function* () {
        const event = this.makeEventResponse<SearchResult>();
        if (this.eventEmitter.listenerCount('request-dl') === 0) {
          yield* this.respondToMessage(
            message.id!,
            { error: 'No event listener for request-dl' },
            event
          );
          return;
        }
        const { appID, info } = message.args as {
          appID: number;
          info: SearchResult;
        };
        this.eventEmitter.emit('request-dl', appID, info, event);
        yield* Effect.forkScoped(this.runDeferredEffect(event));
        const result = yield* this.waitForEventToRespond(event);
        if (event.failed) {
          yield* this.respondToMessage(message.id!, undefined, event);
        } else if (
          event.data === undefined ||
          event.data.downloadType === 'request'
        ) {
          yield* Effect.fail(
            new AddonError({
              message: 'Request DL event returned an invalid request result',
            })
          );
        } else {
          yield* this.respondToMessage(message.id!, result.data, event);
        }
      })
    );
  }

  private handleTaskRun(
    message: AddonServerToClientWebsocketMessage
  ): Effect.Effect<void, AddonError | NetworkError | ValidationError> {
    return Effect.scoped(
      Effect.gen(this, function* () {
        const event = this.makeEventResponse<void>();
        const args = message.args as AddonTaskRunEventArgs;
        const taskName =
          typeof args.taskName === 'string'
            ? args.taskName
            : args.manifest && typeof args.manifest === 'object'
              ? args.manifest.__taskName
              : undefined;
        if (
          typeof taskName !== 'string' ||
          !this.addon.hasTaskHandler(taskName)
        ) {
          event.fail(
            taskName
              ? `No task handler registered for task name: ${taskName}`
              : 'No task name provided'
          );
        } else {
          const task = new Task(event);
          yield* Effect.forkScoped(
            this.reportDeferred(event, args.deferID ?? '')
          );
          const handler = this.addon.getTaskHandler(taskName)!;
          yield* Effect.try({
            try: () =>
              handler(task, {
                manifest: args.manifest || {},
                downloadPath: args.downloadPath || '',
                name: args.name || '',
                libraryInfo: args.libraryInfo,
              }),
            catch: (cause) => new AddonError({ message: formatError(cause) }),
          }).pipe(
            Effect.flatMap((result) =>
              Effect.isEffect(result)
                ? result.pipe(
                    Effect.mapError(
                      (error) => new AddonError({ message: formatError(error) })
                    )
                  )
                : Effect.tryPromise({
                    try: () => Promise.resolve(result),
                    catch: (cause) =>
                      new AddonError({ message: formatError(cause) }),
                  })
            ),
            Effect.catchAll((error) =>
              Effect.sync(() => event.fail(error.message))
            )
          );
        }
        const result = yield* this.waitForEventToRespond(event);
        yield* this.respondToMessage(message.id!, result.data, event);
      })
    );
  }

  private waitForEventToRespond<T>(
    event: EventResponse<T>
  ): Effect.Effect<EventResponse<T>, AddonError> {
    return Effect.gen(function* () {
      const deadline = Date.now() + 5_000;
      while (!event.resolved) {
        if (!event.deffered && Date.now() >= deadline) {
          return yield* Effect.fail(
            new AddonError({ message: 'Event did not respond in time' })
          );
        }
        yield* Effect.sleep(event.deffered ? '100 millis' : '5 millis');
      }
      return event;
    });
  }

  private handleEventWithResponse<T>(
    message: AddonServerToClientWebsocketMessage,
    emit: (event: EventResponse<T>) => void,
    options?: { requireListener: string; noListenerError: string }
  ): Effect.Effect<void, AddonError | NetworkError | ValidationError> {
    return Effect.scoped(
      Effect.gen(this, function* () {
        const event = this.makeEventResponse<T>();
        if (
          options &&
          this.eventEmitter.listenerCount(options.requireListener) === 0
        ) {
          yield* this.respondToMessage(
            message.id!,
            { error: options.noListenerError },
            event
          );
          return;
        }
        emit(event);
        yield* Effect.forkScoped(this.runDeferredEffect(event));
        const result = yield* this.waitForEventToRespond(event);
        yield* this.respondToMessage(message.id!, result.data, event);
      })
    );
  }

  private handleEventWithResponseNoInput<T>(
    message: AddonServerToClientWebsocketMessage,
    emit: (event: EventResponse<T>) => void
  ): Effect.Effect<void, AddonError | NetworkError | ValidationError> {
    return Effect.scoped(
      Effect.gen(this, function* () {
        const event = new EventResponse<T>();
        emit(event);
        yield* Effect.forkScoped(this.runDeferredEffect(event));
        const result = yield* this.waitForEventToRespond(event);
        yield* this.respondToMessage(message.id!, result.data, event);
      })
    );
  }

  public respondToMessage(
    messageID: string,
    response: unknown,
    originalEvent?: EventResponse<unknown>,
    statusError?: string
  ): Effect.Effect<void, NetworkError | ValidationError> {
    return this.transport
      .send(
        {
          event: 'response',
          id: messageID,
          args: response,
          statusError: statusError ?? originalEvent?.failed,
        } as AddonClientToServerWebsocketMessage,
        { expectResponse: false }
      )
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => console.log(`dispatched response to ${messageID}`))
        ),
        Effect.asVoid
      );
  }

  public requestResponse<T>(
    event: AddonClientToServerEventName,
    args: AddonClientToServerEventArgs[AddonClientToServerEventName]
  ): Effect.Effect<T, NetworkError | ValidationError> {
    return this.transport
      .send({ event, args } as AddonClientToServerWebsocketMessage, {
        expectResponse: true,
      })
      .pipe(Effect.map((response) => response.args as T));
  }

  public send(
    event: AddonClientToServerEventName,
    args: AddonClientToServerEventArgs[AddonClientToServerEventName]
  ): Effect.Effect<string, NetworkError | ValidationError> {
    return Effect.gen(this, function* () {
      const id = yield* randomMessageId();
      yield* this.transport.send(
        { event, args, id } as AddonClientToServerWebsocketMessage,
        { expectResponse: false }
      );
      return id;
    });
  }

  public close(): Effect.Effect<void, NetworkError> {
    return this.transport.shutdown('Addon connection closed');
  }
}
