import { NetworkError, ValidationError } from '@ogi/errors';
import type {
  AddonClientSDKToServerIncomingMessage,
  AddonClientSDKToServerWebsocketMessage,
  AddonForwardResponse,
  AddonServerToClientEventArgs,
  AddonServerToClientEventName,
  AddonServerToClientSDKEvent,
  AddonServerToClientSDKEventArgs,
  AddonServerToClientSDKIncomingMessage,
  ConnectedAddonInfo,
  SDKRequest,
  SDKRequestName,
  SDKResponseMessage,
  WebSocketLike,
} from '@ogi-sdk/connect';
import { EventResponseSocket } from '@ogi-sdk/connect';
import type { Cause } from 'effect';
import { Effect, Fiber, PubSub, Stream } from 'effect';
import type {
  AddonForwardResponseMessage,
  AddonProxy,
} from './_generated/addon-proxy';
import { createAddonProxy } from './_generated/addon-proxy';

type WebSocketConstructor = new (url: string) => WebSocketLike;

export type ConnectionOptions = {
  readonly url: string;
  readonly secret?: string;
  readonly webSocket?: WebSocketConstructor;
};

export type DeferredTaskSnapshot<T = unknown> = {
  readonly id: string;
  readonly addonOwner: string;
  readonly finished: boolean;
  readonly progress: number;
  readonly logs: string[];
  readonly failed?: string;
  readonly data?: T;
  readonly resolved: boolean;
};

type MaybePromise = void | Promise<void>;
const asEffect = (value: MaybePromise) =>
  value === undefined ? Effect.void : Effect.tryPromise(() => value);

export type DeferredTaskOptions<T = unknown> = {
  readonly interval?: number;
  readonly onTaskStarted?: (taskID: string) => MaybePromise;
  readonly onProgress?: (
    progress: number,
    task: DeferredTaskSnapshot<T>
  ) => MaybePromise;
  readonly onLogs?: (
    logs: string[],
    task: DeferredTaskSnapshot<T>
  ) => MaybePromise;
  readonly onFailed?: (error: string) => MaybePromise;
};

type InputAskedArgs = AddonServerToClientSDKEventArgs['input-asked'] & {
  readonly reply: (
    result: Record<string, string | number | boolean>
  ) => Promise<void>;
};

type SDKEventArgs<Event extends AddonServerToClientSDKEvent> =
  Event extends 'input-asked'
    ? InputAskedArgs
    : AddonServerToClientSDKEventArgs[Event];

type ConnectionEvent = {
  readonly event: AddonServerToClientSDKEvent;
  readonly args: unknown;
};

/** Anything using the generic `response` envelope rather than `forward`. */
type GenericRequestName = Exclude<SDKRequestName, 'forward'>;

export type ConnectionError = NetworkError | ValidationError;

/** Client SDK connection. */
export class Connection {
  private readonly connectedAddonInfo = new Map<string, ConnectedAddonInfo>();

  private constructor(
    private readonly socket: WebSocketLike,
    private readonly transport: EventResponseSocket<
      AddonServerToClientSDKIncomingMessage,
      AddonClientSDKToServerIncomingMessage
    >,
    private readonly eventPubSub: PubSub.PubSub<ConnectionEvent>
  ) {}

  /** Creates a connected SDK client and installs its message stream consumers. */
  public static make(options: ConnectionOptions): Promise<Connection> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const WebSocketImplementation =
          options.webSocket ??
          (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
        if (!WebSocketImplementation) {
          return yield* Effect.fail(
            new NetworkError({
              message: 'No WebSocket implementation available',
            })
          );
        }

        const url = yield* Connection.getSDKUrl(options.url);
        const socket = yield* Effect.try({
          try: () => new WebSocketImplementation(url),
          catch: (cause) =>
            new NetworkError({
              message: `Unable to create WebSocket: ${String(cause)}`,
              url,
            }),
        });
        const eventPubSub = yield* PubSub.unbounded<ConnectionEvent>();
        let transport:
          | EventResponseSocket<
              AddonServerToClientSDKIncomingMessage,
              AddonClientSDKToServerIncomingMessage
            >
          | undefined;
        return yield* Effect.gen(function* () {
          transport = yield* EventResponseSocket.make<
            AddonServerToClientSDKIncomingMessage,
            AddonClientSDKToServerIncomingMessage
          >(socket, {
            onInvalidMessage: () =>
              Effect.sync(() => {
                console.error('Failed to parse websocket message');
                socket.close(1008, 'Invalid JSON message');
              }),
          });
          const connection = new Connection(socket, transport, eventPubSub);
          yield* connection.connect();
          return connection;
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              if (transport) {
                yield* transport
                  .shutdown('Connection failed')
                  .pipe(Effect.ignore);
              }
              yield* PubSub.shutdown(eventPubSub);
              yield* Effect.sync(() => {
                try {
                  socket.close();
                } catch {
                  // Preserve the original connection error if closing fails.
                }
              });
              return yield* Effect.fail(error);
            })
          )
        );
      })
    );
  }

  /**
   * Returns the generated addon proxy. The generated Promise API is treated as
   * a compatibility boundary and runs the underlying Effects explicitly.
   */
  public addon(
    addonId: string,
    deferredOptions: DeferredTaskOptions = {}
  ): AddonProxy {
    return createAddonProxy(
      addonId,
      (targetAddonId, event, ...args) =>
        this.sendToAddon(targetAddonId, event, ...args),
      this.createDeferToAddon(deferredOptions),
      (id) => this.connectedAddonInfo.get(id)
    );
  }

  public sendToAddon<Event extends AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    ...args: AddonServerToClientEventArgs[Event]
  ): Promise<AddonForwardResponseMessage<Event>> {
    return Effect.runPromise(this.sendToAddonEffect(addonId, event, ...args));
  }

  public request<Name extends GenericRequestName>(
    name: Name,
    args: SDKRequest<Name>
  ): Promise<SDKResponseMessage<Name>> {
    return Effect.runPromise(this.requestEffect(name, args));
  }

  public deferToAddon<Event extends AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    ...args: AddonServerToClientEventArgs[Event]
  ): Promise<string> {
    return Effect.runPromise(this.deferToAddonEffect(addonId, event, ...args));
  }

  public getDeferredTask<T = unknown>(
    taskID: string
  ): Promise<DeferredTaskSnapshot<T> | undefined> {
    return Effect.runPromise(this.getDeferredTaskEffect<T>(taskID));
  }

  public getDeferredTasks(): Promise<DeferredTaskSnapshot[]> {
    return Effect.runPromise(this.getDeferredTasksEffect());
  }

  /** Polls a deferred task until it resolves. */
  public waitForDeferredTask<T = unknown>(
    taskID: string,
    options: DeferredTaskOptions<T> = {}
  ): Promise<T | undefined> {
    return Effect.runPromise(this.waitForDeferredTaskEffect(taskID, options));
  }

  public deferToAddonAndWait<
    T = unknown,
    Event extends AddonServerToClientEventName = AddonServerToClientEventName,
  >(
    addonId: string,
    event: Event,
    args: AddonServerToClientEventArgs[Event],
    options: DeferredTaskOptions<T> = {}
  ): Promise<T | undefined> {
    return Effect.runPromise(
      Effect.gen(this, function* () {
        const taskID = yield* this.deferToAddonEffect(addonId, event, ...args);
        return yield* this.waitForDeferredTaskEffect<T>(taskID, options);
      })
    );
  }

  /** Stream of one SDK event with its event-specific argument type. */
  public events<Event extends AddonServerToClientSDKEvent>(
    event: Event
  ): Stream.Stream<SDKEventArgs<Event>> {
    return Stream.fromPubSub(this.eventPubSub).pipe(
      Stream.filter((item) => item.event === event),
      Stream.map((item) => item.args as SDKEventArgs<Event>)
    );
  }

  /** Forks a callback as a consumer of an SDK event stream. */
  public on<Event extends AddonServerToClientSDKEvent, E>(
    event: Event,
    callback: (args: SDKEventArgs<Event>) => Effect.Effect<void, E> | void
  ): Effect.Effect<Fiber.RuntimeFiber<void, E>> {
    return this.events(event).pipe(
      Stream.runForEach((args) => {
        const result = callback(args);
        return Effect.isEffect(result) ? result : Effect.void;
      }),
      Effect.forkDaemon
    );
  }

  public close(): Promise<void> {
    return Effect.runPromise(
      Effect.gen(this, function* () {
        yield* PubSub.shutdown(this.eventPubSub);
        yield* this.transport.shutdown('Connection closed');
      })
    );
  }

  public dispose(): Promise<void> {
    return this.close();
  }

  private sendToAddonEffect<Event extends AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    ...args: AddonServerToClientEventArgs[Event]
  ): Effect.Effect<AddonForwardResponseMessage<Event>, ConnectionError> {
    return this.transport
      .send(
        {
          event: 'forward',
          args: { addonId, event, args },
        } as AddonClientSDKToServerWebsocketMessage<'forward', Event>,
        { expectResponse: true, responseEvent: 'forward-response' }
      )
      .pipe(
        Effect.map((response) => response as AddonForwardResponseMessage<Event>)
      );
  }

  private requestEffect<Name extends GenericRequestName>(
    name: Name,
    args: SDKRequest<Name>
  ): Effect.Effect<SDKResponseMessage<Name>, ConnectionError> {
    return Effect.gen(this, function* () {
      const response = (yield* this.transport.send(
        {
          event: name,
          args,
        } as AddonClientSDKToServerIncomingMessage,
        { expectResponse: true, responseEvent: 'response' }
      )) as SDKResponseMessage<Name>;

      if (name === 'query-connected-addons' && !response.statusError) {
        const addons = (
          response as SDKResponseMessage<'query-connected-addons'>
        ).args.addons;
        for (const addon of addons) {
          this.connectedAddonInfo.set(addon.id, addon);
        }
      }
      return response;
    });
  }

  private deferToAddonEffect<Event extends AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    ...args: AddonServerToClientEventArgs[Event]
  ): Effect.Effect<string, ConnectionError> {
    return Effect.gen(this, function* () {
      const response = yield* this.requestEffect('defer-forward', {
        addonId,
        event,
        args,
      });
      if (response.statusError) {
        return yield* Effect.fail(
          new NetworkError({ message: response.statusError })
        );
      }
      return response.args.taskID;
    });
  }

  private getDeferredTaskEffect<T = unknown>(
    taskID: string
  ): Effect.Effect<DeferredTaskSnapshot<T> | undefined, ConnectionError> {
    return Effect.gen(this, function* () {
      const response = yield* this.requestEffect('get-deferred-task', {
        taskID,
      });
      if (response.statusError) {
        return yield* Effect.fail(
          new NetworkError({ message: response.statusError })
        );
      }
      return response.args.task as DeferredTaskSnapshot<T> | undefined;
    });
  }

  private getDeferredTasksEffect(): Effect.Effect<
    DeferredTaskSnapshot[],
    ConnectionError
  > {
    return Effect.gen(this, function* () {
      const response = yield* this.requestEffect('get-deferred-tasks', {});
      if (response.statusError) {
        return yield* Effect.fail(
          new NetworkError({ message: response.statusError })
        );
      }
      return response.args.tasks as DeferredTaskSnapshot[];
    });
  }

  private waitForDeferredTaskEffect<T = unknown>(
    taskID: string,
    options: DeferredTaskOptions<T> = {}
  ): Effect.Effect<T | undefined, ConnectionError | Cause.UnknownException> {
    const interval = options.interval ?? 50;
    return Effect.gen(this, function* () {
      while (true) {
        const task = yield* this.getDeferredTaskEffect<T>(taskID).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              if (options.onFailed) {
                yield* asEffect(options.onFailed(error.message));
              }
              return yield* Effect.fail(error);
            })
          )
        );
        if (!task) {
          const message = 'Task not found';
          if (options.onFailed) yield* asEffect(options.onFailed(message));
          return yield* Effect.fail(new NetworkError({ message }));
        }

        if (options.onProgress) {
          yield* asEffect(options.onProgress(task.progress, task));
        }
        if (options.onLogs) yield* asEffect(options.onLogs(task.logs, task));

        if (task.failed) {
          if (options.onFailed) yield* asEffect(options.onFailed(task.failed));
          return yield* Effect.fail(new NetworkError({ message: task.failed }));
        }
        if (task.resolved) return task.data;
        yield* Effect.sleep(interval);
      }
    });
  }

  private connect(): Effect.Effect<void, NetworkError> {
    return Effect.gen(this, function* () {
      yield* this.transport.on('notification', (message) =>
        PubSub.publish(this.eventPubSub, {
          event: 'notification',
          args: message.args,
        }).pipe(Effect.asVoid)
      );

      yield* this.transport.on('input-asked', (message) => {
        if (!message.id) return Effect.void;
        const id = message.id;
        return PubSub.publish(this.eventPubSub, {
          event: 'input-asked',
          args: {
            ...message.args,
            reply: (result: Record<string, string | number | boolean>) =>
              Effect.runPromise(
                this.transport
                  .send(
                    {
                      event: 'input-response',
                      id,
                      args: result,
                    } as AddonClientSDKToServerIncomingMessage,
                    { expectResponse: false }
                  )
                  .pipe(Effect.asVoid)
              ),
          } satisfies InputAskedArgs,
        }).pipe(Effect.asVoid);
      });

      if (this.socket.readyState === 1) return;

      yield* Effect.async<void, NetworkError>((resume) => {
        const socketWithRemoval = this.socket as WebSocketLike & {
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeEventListener?: (
            event: string,
            listener: (...args: unknown[]) => void
          ) => void;
        };
        const cleanup = (): void => {
          socketWithRemoval.off?.('open', onOpen);
          socketWithRemoval.off?.('error', onError);
          socketWithRemoval.off?.('close', onClose);
          socketWithRemoval.removeEventListener?.('open', onOpen);
          socketWithRemoval.removeEventListener?.('error', onError);
          socketWithRemoval.removeEventListener?.('close', onClose);
        };
        const onOpen = (): void => {
          cleanup();
          resume(Effect.void);
        };
        const onError = (cause?: unknown): void => {
          cleanup();
          resume(
            Effect.fail(
              new NetworkError({
                message: `WebSocket connection error: ${String(cause ?? '')}`,
              })
            )
          );
        };
        const onClose = (): void => {
          cleanup();
          resume(
            Effect.fail(
              new NetworkError({
                message: 'WebSocket closed before opening',
              })
            )
          );
        };

        if (this.socket.on) {
          this.socket.on('open', onOpen);
          this.socket.on('error', onError);
          this.socket.on('close', onClose);
        } else {
          this.socket.addEventListener?.('open', onOpen);
          this.socket.addEventListener?.('error', onError);
          this.socket.addEventListener?.('close', onClose);
        }
        return Effect.sync(cleanup);
      }).pipe(
        Effect.timeoutFail({
          duration: '10 seconds',
          onTimeout: () =>
            new NetworkError({ message: 'WebSocket connection timed out' }),
        })
      );
    });
  }

  /** Compatibility adapter used solely by the generated Promise proxy. */
  private createDeferToAddon(deferredOptions: DeferredTaskOptions = {}) {
    return <Event extends AddonServerToClientEventName>(
      targetAddonId: string,
      event: Event,
      args: AddonServerToClientEventArgs[Event]
    ): Promise<AddonForwardResponse<Event>['args']> =>
      Effect.runPromise(
        Effect.gen(this, function* () {
          const taskID = yield* this.deferToAddonEffect(
            targetAddonId,
            event,
            ...args
          );
          if (deferredOptions.onTaskStarted) {
            yield* asEffect(deferredOptions.onTaskStarted(taskID));
          }
          const result = yield* this.waitForDeferredTaskEffect<
            AddonForwardResponse<Event>['args']
          >(
            taskID,
            deferredOptions as DeferredTaskOptions<
              AddonForwardResponse<Event>['args']
            >
          );
          return result as AddonForwardResponse<Event>['args'];
        })
      );
  }

  private static getSDKUrl(
    url: string
  ): Effect.Effect<string, ValidationError> {
    return Effect.try({
      try: () => {
        const parsed = new URL(url);
        if (parsed.pathname === '/') parsed.pathname = '/sdk';
        return parsed.toString();
      },
      catch: (cause) =>
        new ValidationError({
          message: `Invalid connection URL: ${String(cause)}`,
          field: 'url',
        }),
    });
  }
}
