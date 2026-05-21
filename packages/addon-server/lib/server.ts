import { AddonConnection } from './connections/addon.connection';
import { ClientConnection } from './connections/client.connection';
import {
  WebSocketServer,
  createWebSocketUpgradeListener,
  type WebSocket,
} from '@ogi-sdk/connect';
import http from 'http';
import { EventEmitter } from 'events';
import type {
  AddonNotificationMessage,
  AddonServerHostEventListeners,
  AddonServerHostEventName,
  ConfigurationFile,
} from '@ogi-sdk/connect';
import { DeferredTasksManager } from './deffered';

export type AddonConfig = {
  securityCheck: boolean;
  port: number;
  secret?: string;
};

// If changing stuff like this, update it in packages/connection/lib/protocol.ts at the bottom of the file
export type AddonServerEventListeners =
  AddonServerHostEventListeners<AddonConnection>;

export type AddonServerEventName = AddonServerHostEventName;

export class AddonServer {
  private connections: Set<AddonConnection> = new Set();
  private sdkConnections: Set<ClientConnection> = new Set();
  private clients: Map<string, AddonConnection> = new Map();

  private server = http.createServer();
  private wss: WebSocketServer | undefined;
  private upgradeListener?: ReturnType<typeof createWebSocketUpgradeListener>;

  private deferredTasksManager: DeferredTasksManager =
    new DeferredTasksManager();
  public constructor(private readonly config: AddonConfig) {
    // create a random secret if not provided
    if (config.securityCheck && !config.secret) {
      config.secret = `${Math.floor(new Date().getTime() + Math.random() * 10000)}-${Math.floor(Math.random() * 10000)}`;
    }
  }

  private eventEmitter = new EventEmitter();

  public emit<T extends AddonServerEventName>(
    event: T,
    ...args: Parameters<AddonServerEventListeners[T]>
  ): this {
    if (event === 'notification') {
      const [notification] = args as [AddonNotificationMessage];
      this.sdkConnections.forEach((connection) => {
        void connection.sendNotification(notification);
      });
    }

    if (event === 'input-asked') {
      const [name, description, config, reply] = args as [
        string,
        string,
        ConfigurationFile,
        (reply: Record<string, string | number | boolean>) => void,
      ];
      const [connection] = this.sdkConnections;
      void (async () => {
        try {
          reply(connection ? await connection.askInput(name, description, config) : {});
        } catch (error) {
          console.error('Failed to ask SDK for input:', error);
          reply({});
        }
      })();
    }

    this.eventEmitter.emit(event, ...args);
    return this;
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
    if (connection.addonInfo) {
      this.clients.delete(connection.addonInfo.id);
    }
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
    return this.config.secret!;
  }

  public stop(): void {
    if (this.upgradeListener) {
      this.server.removeListener('upgrade', this.upgradeListener);
      this.upgradeListener = undefined;
    }
    this.connections.forEach((connection) => {
      connection.ws.close();
    });
    this.clients.forEach((client) => {
      client.ws.close();
    });
    this.sdkConnections.forEach((connection) => {
      connection.close();
    });
    this.wss?.close();
    this.wss = undefined;
    this.server.close();
    this.connections.clear();
    this.sdkConnections.clear();
    this.clients.clear();
  }

  public async start(): Promise<void> {
    if (this.upgradeListener) {
      this.server.removeListener('upgrade', this.upgradeListener);
      this.upgradeListener = undefined;
    }
    this.wss?.close();
    this.wss = new WebSocketServer({ noServer: true });
    this.upgradeListener = createWebSocketUpgradeListener(this.wss);
    this.server.on('upgrade', this.upgradeListener);

    this.wss.on('connection', (ws: WebSocket, request) => {
      if (request.url?.startsWith('/sdk')) {
        const connection = new ClientConnection(ws, this);
        this.sdkConnections.add(connection);
        ws.on('close', () => this.sdkConnections.delete(connection));
        return;
      }

      const connection = new AddonConnection(ws, this.config, this);
      this.connections.add(connection);
      ws.on('close', () => {
        this.removeConnection(connection);
        this.eventEmitter.emit('disconnect', 'Addon websocket closed');
      });
      connection.setupWebsocket().then((success) => {
        if (!success) {
          this.removeConnection(connection);
          this.eventEmitter.emit('disconnect', 'Failed to setup websocket');
        } else {
          this.eventEmitter.emit('connect', connection);
        }
      });
    });

    this.server.listen(this.config.port, () => {
      this.eventEmitter.emit('start');
    });
  }
}
