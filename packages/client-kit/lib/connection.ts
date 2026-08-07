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
import { NetworkError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Exit, Fiber, PubSub, Stream } from 'effect';
import type {
  AddonForwardResponseMessage,
  EffectAddonProxy,
} from './_generated/addon-proxy';
import { createEffectAddonProxy } from './_generated/addon-proxy';

const logger = createLogger(LOGGER_PREFIXES.clientKit);

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

export type EffectDeferredTaskOptions<T = unknown, E = never> = {
  readonly interval?: number;
  readonly onTaskStarted?: (taskID: string) => Effect.Effect<void, E>;
  readonly onProgress?: (
    progress: number,
    task: DeferredTaskSnapshot<T>
  ) => Effect.Effect<void, E>;
  readonly onLogs?: (
    logs: string[],
    task: DeferredTaskSnapshot<T>
  ) => Effect.Effect<void, E>;
  readonly onFailed?: (error: string) => Effect.Effect<void, E>;
};

type InputAskedArgs = AddonServerToClientSDKEventArgs['input-asked'] & {
  readonly reply: (
    result: Record<string, string | number | boolean>
  ) => Effect.Effect<void, ConnectionError>;
};

export type SDKEventArgs<Event extends AddonServerToClientSDKEvent> =
  Event extends 'input-asked'
    ? InputAskedArgs
    : AddonServerToClientSDKEventArgs[Event];

type ConnectionEvent = {
  readonly event: AddonServerToClientSDKEvent;
  readonly args: unknown;
};

type GenericRequestName = Exclude<SDKRequestName, 'forward'>;

export type ConnectionError = NetworkError | ValidationError;

/** Effect-native client SDK connection. */
export class EffectConnection {
  private readonly connectedAddonInfo = new Map<string, ConnectedAddonInfo>();

  private constructor(
    private readonly socket: WebSocketLike,
    private readonly transport: EventResponseSocket<
      AddonServerToClientSDKIncomingMessage,
      AddonClientSDKToServerIncomingMessage
    >,
    private readonly eventPubSub: PubSub.PubSub<ConnectionEvent>
  ) {}

  /** Creates a connected client and installs supervised message consumers. */
  public static make(
    options: ConnectionOptions
  ): Effect.Effect<EffectConnection, ConnectionError> {
    return Effect.gen(function* () {
      const WebSocketImplementation =
        options.webSocket ??
        (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
      if (!WebSocketImplementation) {
        return yield* Effect.fail(
          new NetworkError({ message: 'No WebSocket implementation available' })
        );
      }

      const url = yield* EffectConnection.getSDKUrl(options.url);
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
            Effect.gen(function* () {
              yield* logger.error('Failed to parse websocket message');
              socket.close(1008, 'Invalid JSON message');
            }),
        });
        const connection = new EffectConnection(socket, transport, eventPubSub);
        yield* connection.connect();
        return connection;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.gen(function* () {
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
                    // Preserve the original connection failure if closing fails.
                  }
                });
              })
        )
      );
    });
  }

  public addon<E = never>(
    addonId: string,
    deferredOptions: EffectDeferredTaskOptions<unknown, E> = {}
  ): EffectAddonProxy<E> {
    return createEffectAddonProxy(
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

  public request<Name extends GenericRequestName>(
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
        for (const addon of addons)
          this.connectedAddonInfo.set(addon.id, addon);
      }
      return response;
    });
  }

  public deferToAddon<Event extends AddonServerToClientEventName>(
    addonId: string,
    event: Event,
    ...args: AddonServerToClientEventArgs[Event]
  ): Effect.Effect<string, ConnectionError> {
    return Effect.gen(this, function* () {
      const response = yield* this.request('defer-forward', {
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

  public getDeferredTask<T = unknown>(
    taskID: string
  ): Effect.Effect<DeferredTaskSnapshot<T> | undefined, ConnectionError> {
    return Effect.gen(this, function* () {
      const response = yield* this.request('get-deferred-task', { taskID });
      if (response.statusError) {
        return yield* Effect.fail(
          new NetworkError({ message: response.statusError })
        );
      }
      return response.args.task as DeferredTaskSnapshot<T> | undefined;
    });
  }

  public getDeferredTasks(): Effect.Effect<
    DeferredTaskSnapshot[],
    ConnectionError
  > {
    return Effect.gen(this, function* () {
      const response = yield* this.request('get-deferred-tasks', {});
      if (response.statusError) {
        return yield* Effect.fail(
          new NetworkError({ message: response.statusError })
        );
      }
      return response.args.tasks as DeferredTaskSnapshot[];
    });
  }

  /** Polls a deferred task until it resolves. */
  public waitForDeferredTask<T = unknown, E = never>(
    taskID: string,
    options: EffectDeferredTaskOptions<T, E> = {}
  ): Effect.Effect<T | undefined, ConnectionError | E> {
    const interval = options.interval ?? 50;
    return Effect.gen(this, function* () {
      while (true) {
        const task = yield* this.getDeferredTask<T>(taskID).pipe(
          Effect.tapError(
            (error) => options.onFailed?.(error.message) ?? Effect.void
          )
        );
        if (!task) {
          const message = 'Task not found';
          if (options.onFailed) yield* options.onFailed(message);
          return yield* Effect.fail(new NetworkError({ message }));
        }

        if (options.onProgress) {
          yield* options.onProgress(task.progress, task);
        }
        if (options.onLogs) yield* options.onLogs(task.logs, task);

        if (task.failed) {
          if (options.onFailed) yield* options.onFailed(task.failed);
          return yield* Effect.fail(new NetworkError({ message: task.failed }));
        }
        if (task.resolved) return task.data;
        yield* Effect.sleep(interval);
      }
    });
  }

  public deferToAddonAndWait<
    T = unknown,
    E = never,
    Event extends AddonServerToClientEventName = AddonServerToClientEventName,
  >(
    addonId: string,
    event: Event,
    args: AddonServerToClientEventArgs[Event],
    options: EffectDeferredTaskOptions<T, E> = {}
  ): Effect.Effect<T | undefined, ConnectionError | E> {
    return Effect.gen(this, function* () {
      const taskID = yield* this.deferToAddon(addonId, event, ...args);
      return yield* this.waitForDeferredTask<T, E>(taskID, options);
    });
  }

  public events<Event extends AddonServerToClientSDKEvent>(
    event: Event
  ): Stream.Stream<SDKEventArgs<Event>> {
    return Stream.fromPubSub(this.eventPubSub).pipe(
      Stream.filter((item) => item.event === event),
      Stream.map((item) => item.args as SDKEventArgs<Event>)
    );
  }

  public on<Event extends AddonServerToClientSDKEvent, E>(
    event: Event,
    callback: (args: SDKEventArgs<Event>) => Effect.Effect<void, E>
  ): Effect.Effect<Fiber.RuntimeFiber<void, E>> {
    return this.transport.fork(
      this.events(event).pipe(Stream.runForEach(callback))
    );
  }

  public close(): Effect.Effect<void, NetworkError> {
    return Effect.gen(this, function* () {
      yield* PubSub.shutdown(this.eventPubSub);
      yield* this.transport.shutdown('Connection closed');
    });
  }

  public dispose(): Effect.Effect<void, NetworkError> {
    return this.close();
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
              this.transport
                .send(
                  {
                    event: 'input-response',
                    id,
                    args: result,
                  } as AddonClientSDKToServerIncomingMessage,
                  { expectResponse: false }
                )
                .pipe(Effect.asVoid),
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
              new NetworkError({ message: 'WebSocket closed before opening' })
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

  private createDeferToAddon<E>(
    deferredOptions: EffectDeferredTaskOptions<unknown, E>
  ) {
    return <Event extends AddonServerToClientEventName>(
      targetAddonId: string,
      event: Event,
      args: AddonServerToClientEventArgs[Event]
    ): Effect.Effect<
      AddonForwardResponse<Event>['args'],
      ConnectionError | E
    > =>
      Effect.gen(this, function* () {
        const taskID = yield* this.deferToAddon(targetAddonId, event, ...args);
        if (deferredOptions.onTaskStarted) {
          yield* deferredOptions.onTaskStarted(taskID);
        }
        const result = yield* this.waitForDeferredTask<
          AddonForwardResponse<Event>['args'],
          E
        >(
          taskID,
          deferredOptions as EffectDeferredTaskOptions<
            AddonForwardResponse<Event>['args'],
            E
          >
        );
        return result === undefined
          ? yield* Effect.fail(
              new NetworkError({
                message: `Deferred task ${taskID} completed without data`,
              })
            )
          : result;
      });
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
