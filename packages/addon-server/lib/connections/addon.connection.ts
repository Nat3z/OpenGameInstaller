import type { NetworkError, ValidationError } from '@ogi/errors';
import type {
  AddonClientToServerWebsocketMessage,
  AddonServerToClientEventArgs,
  AddonServerToClientWebsocketMessage,
  ConfigurationFile,
  OGIAddonConfiguration,
  OGIAddonSDKEventListener,
} from '@ogi-sdk/connect';
import { EventResponseSocket, type WebSocketLike } from '@ogi-sdk/connect';
import { Deferred, Effect } from 'effect';
import {
  buildEventMessage,
  eventAliases,
  type SendEventProxy,
} from '../_generated/event-proxy';
import { createClientMessageHandlers } from '../handlers/client-message-handlers';
import type { ClientMessageHandlers } from '../handlers/types';
import type { AddonConfig, AddonServer } from '../server';
import { bindWebSocketLifecycle } from './websocket-lifecycle';

export type AddonConnectionError = NetworkError | ValidationError;

/** Effect-based connection to one addon process. */
export class AddonConnection {
  public addonInfo: OGIAddonConfiguration | undefined;
  public configTemplate: ConfigurationFile | undefined;
  public filePath: string | undefined;
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
          Effect.sync(() => {
            console.error('Failed to parse websocket message');
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
    return this.events.noResponse.configUpdate(config).pipe(Effect.asVoid);
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
            : Effect.sync(() => {
                this.ws.close(1008, 'Authentication timeout');
                console.error('Client kicked due to authentication timeout');
                return false;
              })
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
