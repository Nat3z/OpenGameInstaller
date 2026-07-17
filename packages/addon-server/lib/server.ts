import { NetworkError } from '@ogi/errors';
import type {
  AddonNotificationMessage,
  AddonServerHostEventListeners,
  AddonServerHostEventName,
  ConfigurationFile,
} from '@ogi-sdk/connect';
import { randomUUID } from 'crypto';
import { Effect } from 'effect';
import { EventEmitter } from 'events';
import http from 'http';
import { type WebSocket, WebSocketServer } from 'ws';
import { AddonConnection } from './connections/addon.connection';
import { ClientConnection } from './connections/client.connection';
import { DeferredTasksManager } from './deffered';

export type AddonConfig = {
  securityCheck: boolean;
  port: number;
  secret?: string;
};

export type AddonServerEventListeners =
  AddonServerHostEventListeners<AddonConnection>;
export type AddonServerEventName = AddonServerHostEventName;

/** HTTP/WebSocket addon server whose lifecycle is represented by Effects. */
export class AddonServer {
  private readonly connections = new Set<AddonConnection>();
  private readonly sdkConnections = new Set<ClientConnection>();
  private readonly clients = new Map<string, AddonConnection>();
  private readonly deferredTasksManager = new DeferredTasksManager();
  private readonly eventEmitter = new EventEmitter();
  private server = http.createServer();
  private wss: WebSocketServer | undefined;
  private upgradeListener?: (
    req: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer
  ) => void;
  private healthListener?: (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => void;

  public constructor(private readonly config: AddonConfig) {
    this.config.secret ??= randomUUID();
  }

  /** EventEmitter compatibility boundary. Effectful fan-out is forked explicitly. */
  public emit<T extends AddonServerEventName>(
    event: T,
    ...args: Parameters<AddonServerEventListeners[T]>
  ): this {
    Effect.runFork(this.emitEffect(event, ...args));
    return this;
  }

  public emitEffect<T extends AddonServerEventName>(
    event: T,
    ...args: Parameters<AddonServerEventListeners[T]>
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (event === 'notification') {
        const [notification] = args as [AddonNotificationMessage];
        yield* Effect.forEach(
          this.sdkConnections,
          (connection) =>
            connection.sendNotification(notification).pipe(Effect.ignore),
          { concurrency: 'unbounded', discard: true }
        );
      }
      if (event === 'input-asked') {
        const [name, description, config, reply] = args as [
          string,
          string,
          ConfigurationFile,
          (value: Record<string, string | number | boolean>) => void,
        ];
        const [connection] = this.sdkConnections;
        const answer = connection
          ? yield* connection
              .askInput(name, description, config)
              .pipe(Effect.catchAll(() => Effect.succeed({})))
          : {};
        reply(answer);
      }
      this.eventEmitter.emit(event, ...args);
    });
  }

  public getConnections(): Set<AddonConnection> {
    return this.connections;
  }
  public getClient(id: string): AddonConnection | undefined {
    return this.clients.get(id);
  }
  public addClient(id: string, connection: AddonConnection): void {
    this.clients.set(id, connection);
  }
  public getDeferredTasksManager(): DeferredTasksManager {
    return this.deferredTasksManager;
  }

  public removeConnection(connection: AddonConnection): void {
    this.connections.delete(connection);
    if (connection.addonInfo) this.clients.delete(connection.addonInfo.id);
  }

  public on<T extends AddonServerEventName>(
    event: T,
    listener: AddonServerEventListeners[T]
  ): this {
    this.eventEmitter.on(event, listener);
    return this;
  }

  public extend(server: http.Server): this {
    this.server = server;
    return this;
  }

  public getSecret(): string {
    return this.config.secret ?? '';
  }

  public stop(): Effect.Effect<void, NetworkError> {
    return Effect.gen(this, function* () {
      this.detachListeners();
      for (const connection of this.connections) connection.ws.close();
      for (const connection of this.sdkConnections)
        yield* connection.close().pipe(Effect.ignore);

      if (this.wss) {
        const wss = this.wss;
        yield* Effect.async<void, NetworkError>((resume) => {
          wss.close((error) =>
            resume(
              error
                ? Effect.fail(
                    new NetworkError({
                      message: `Unable to stop websocket server: ${error.message}`,
                    })
                  )
                : Effect.void
            )
          );
        });
      }
      this.wss = undefined;

      if (this.server.listening) {
        yield* Effect.async<void, NetworkError>((resume) => {
          this.server.close((error) =>
            resume(
              error
                ? Effect.fail(
                    new NetworkError({
                      message: `Unable to stop HTTP server: ${error.message}`,
                    })
                  )
                : Effect.void
            )
          );
        });
      }
      this.connections.clear();
      this.sdkConnections.clear();
      this.clients.clear();
    });
  }

  private handleWebSocketConnection(
    ws: WebSocket,
    request: http.IncomingMessage
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (request.url?.startsWith('/sdk')) {
        const connection = yield* ClientConnection.make(ws, this);
        this.sdkConnections.add(connection);
        ws.on('close', () => this.sdkConnections.delete(connection));
        return;
      }
      const connection = yield* AddonConnection.make(ws, this.config, this);
      this.connections.add(connection);
      ws.on('close', () => {
        this.removeConnection(connection);
        this.eventEmitter.emit(
          'disconnect',
          `${connection.addonInfo?.name ?? 'Addon'} websocket closed`
        );
      });
      const success = yield* connection.setupWebsocket();
      if (!success) {
        this.removeConnection(connection);
        this.eventEmitter.emit('disconnect', 'Failed to setup websocket');
      } else {
        this.eventEmitter.emit('connect', connection);
      }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          ws.close(1011, error.message);
          this.eventEmitter.emit('disconnect', error.message);
        })
      )
    );
  }

  private healthHandler(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const pathname = req.url?.split('?')[0]?.replace(/\/+$/, '') ?? '';
    if (pathname === '/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
    }
  }

  public start(): Effect.Effect<void, NetworkError> {
    return Effect.gen(this, function* () {
      this.detachListeners();
      this.wss?.close();
      this.wss = new WebSocketServer({ noServer: true });
      this.upgradeListener = (req, socket, head) => {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          Effect.runFork(this.handleWebSocketConnection(ws, req));
        });
      };
      this.server.on('upgrade', this.upgradeListener);
      this.healthListener = this.healthHandler.bind(this);
      this.server.on('request', this.healthListener);

      yield* Effect.async<void, NetworkError>((resume) => {
        const onError = (cause: Error): void => {
          this.server.off('error', onError);
          resume(
            Effect.fail(
              new NetworkError({
                message: `Unable to start addon server: ${cause.message}`,
              })
            )
          );
        };
        this.server.once('error', onError);
        this.server.listen(this.config.port, () => {
          this.server.off('error', onError);
          this.eventEmitter.emit('start');
          resume(Effect.void);
        });
      });
    });
  }

  private detachListeners(): void {
    if (this.upgradeListener)
      this.server.removeListener('upgrade', this.upgradeListener);
    if (this.healthListener)
      this.server.removeListener('request', this.healthListener);
    this.upgradeListener = undefined;
    this.healthListener = undefined;
  }
}
