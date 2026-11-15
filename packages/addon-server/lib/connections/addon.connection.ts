import type {
  AddonClientToServerWebsocketMessage,
  AddonServerToClientEventArgs,
  AddonServerToClientWebsocketMessage,
  ConfigurationFile,
  OGIAddonConfiguration,
  OGIAddonSDKEventListener,
} from '@ogi-sdk/connect';
import { EventResponseSocket, type WebSocketLike } from '@ogi-sdk/connect';
import { NetworkError, type ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { randomUUID } from 'crypto';
import { Deferred, Duration, Effect, Fiber, Schedule } from 'effect';
import {
  buildEventMessage,
  eventAliases,
  type SendEventProxy,
} from '../_generated/event-proxy';
import { DeferrableTask } from '../deffered';
import { createClientMessageHandlers } from '../handlers/client-message-handlers';
import type { ClientMessageHandlers } from '../handlers/types';
import type { AddonConfig, AddonServer } from '../server';
import { bindWebSocketLifecycle } from './websocket-lifecycle';

const logger = createLogger(LOGGER_PREFIXES.addonServer);

export type AddonConnectionError = NetworkError | ValidationError;

/** What a deferred addon event has reported so far. */
export type DeferredProgress = {
  readonly progress: number;
  readonly logs: readonly string[];
};

/** Effect-based connection to one addon process. */
export class AddonConnection {
  public addonInfo: OGIAddonConfiguration | undefined;
  public configTemplate: ConfigurationFile | undefined;
  public filePath: string | undefined;
  /** The secret the addon authenticated with. */
  public secret: string | undefined;
  public addonLink: string | undefined;
  public eventsAvailable: OGIAddonSDKEventListener[] = [];
  public readonly events: SendEventProxy;

  private constructor(
    public readonly ws: WebSocketLike,
    private readonly config: AddonConfig,
    private readonly server: AddonServer,
    private readonly transport: EventResponseSocket<
      AddonClientToServerWebsocketMessage,
      AddonServerToClientWebsocketMessage
    >,
    private readonly clientEventHandlers: ClientMessageHandlers
  ) {
    this.events = this.createSendEventProxy(true);
  }

  public static make(
    ws: WebSocketLike,
    config: AddonConfig,
    server: AddonServer
  ): Effect.Effect<AddonConnection, NetworkError> {
    return Effect.gen(function* () {
      const transport = yield* EventResponseSocket.make<
        AddonClientToServerWebsocketMessage,
        AddonServerToClientWebsocketMessage
      >(ws, {
        onInvalidMessage: () =>
          Effect.gen(function* () {
            yield* logger.error('Failed to parse websocket message');
            ws.close(1008, 'Invalid JSON message');
          }),
      });
      return new AddonConnection(
        ws,
        config,
        server,
        transport,
        createClientMessageHandlers()
      );
    });
  }

  public configure(
    config: ConfigurationFile
  ): Effect.Effect<void, AddonConnectionError> {
    // the addon rejects a config-update without an id, so expect a response
    return this.events.configUpdate(config).pipe(Effect.asVoid);
  }

  public setupWebsocket(): Effect.Effect<boolean, NetworkError> {
    return Effect.gen(this, function* () {
      const authentication = yield* Deferred.make<boolean>();

      for (const [event, handler] of Object.entries(this.clientEventHandlers)) {
        if (!handler) continue;
        yield* this.transport.on(
          event as AddonClientToServerWebsocketMessage['event'],
          (message) =>
            handler(
              {
                connection: this,
                config: this.config,
                server: this.server,
                resolveAuthentication: (authenticated) =>
                  Deferred.succeed(authentication, authenticated).pipe(
                    Effect.asVoid
                  ),
              },
              message as AddonClientToServerWebsocketMessage
            )
        );
      }

      const unbindLifecycle = yield* bindWebSocketLifecycle(
        this.ws,
        (effect) => this.transport.run(effect),
        {
          onClose: () =>
            this.transport.shutdown('Websocket closed').pipe(Effect.ignore),
          onError: () =>
            this.transport.shutdown('Websocket error').pipe(Effect.ignore),
        }
      );
      yield* this.transport.addFinalizer(Effect.sync(unbindLifecycle));

      return yield* Deferred.await(authentication).pipe(
        Effect.timeoutOption('1 second'),
        Effect.flatMap((result) =>
          result._tag === 'Some'
            ? Effect.succeed(result.value)
            : Effect.gen(this, function* () {
                this.ws.close(1008, 'Authentication timeout');
                yield* logger.error(
                  'Client kicked due to authentication timeout'
                );
                return false;
              })
        )
      );
    });
  }

  /**
   * Sends an event the addon answers later (`setup`, `request-dl`) and waits
   * for its result. The addon's `defer-update`s land on a task with the
   * message's id; `onProgress` sees each change while it runs.
   */
  public deferred<Event extends keyof AddonServerToClientEventArgs>(
    event: Event,
    args: AddonServerToClientEventArgs[Event],
    onProgress: (progress: DeferredProgress) => Effect.Effect<void> = () =>
      Effect.void
  ): Effect.Effect<unknown, AddonConnectionError> {
    return Effect.gen(this, function* () {
      const message = buildEventMessage(event, args);
      message.id = randomUUID();
      const tasks = this.server.getDeferredTasksManager();
      const task = new DeferrableTask(
        () => Effect.never,
        this.addonInfo?.id ?? ''
      );
      task.id = message.id;
      yield* tasks.startTask(task);

      let last = '';
      const report = Effect.suspend(() => {
        const key = `${task.progress}:${task.logs.length}`;
        if (key === last) return Effect.void;
        last = key;
        return onProgress({ progress: task.progress, logs: task.logs });
      });
      const reporter = yield* Effect.fork(
        Effect.repeat(report, Schedule.spaced(Duration.millis(250)))
      );
      // The addon either replies on the socket or reports failure on the task.
      const failed = Effect.gen(function* () {
        while (task.failed === undefined) yield* Effect.sleep('250 millis');
        return yield* Effect.fail(new NetworkError({ message: task.failed }));
      });
      return yield* Effect.raceFirst(
        this.sendEventMessage(message).pipe(
          Effect.flatMap((response) =>
            response.statusError
              ? Effect.fail(new NetworkError({ message: response.statusError }))
              : Effect.succeed(response.args)
          )
        ),
        failed
      ).pipe(
        Effect.ensuring(
          report.pipe(
            Effect.zipRight(Fiber.interrupt(reporter)),
            Effect.zipRight(tasks.removeTask(task.id))
          )
        )
      );
    });
  }

  public sendEventMessage(
    message: AddonServerToClientWebsocketMessage,
    expectResponse = true
  ): Effect.Effect<AddonClientToServerWebsocketMessage, AddonConnectionError> {
    return this.transport.send(message, { expectResponse });
  }

  private createSendEventProxy(defaultExpectResponse: boolean): SendEventProxy {
    return new Proxy(
      {},
      {
        get: (_, property) => {
          if (property === 'noResponse')
            return this.createSendEventProxy(false);
          if (typeof property !== 'string') return undefined;

          const event = eventAliases[property];
          if (!event) return undefined;

          return (...args: AddonServerToClientEventArgs[typeof event]) =>
            this.sendEventMessage(
              buildEventMessage(event, args),
              event === 'response' ? false : defaultExpectResponse
            );
        },
      }
    ) as SendEventProxy;
  }
}
