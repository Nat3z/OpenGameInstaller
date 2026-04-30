import { AddonConnection } from './addon-connection';
import { WebSocketServer } from 'ws';
import http from 'http';
import { EventEmitter } from 'events';
import type { ConfigurationBuilder, Notification } from 'ogi-addon';
import { DeferredTasksManager } from './deffered';
import type { ConfigurationFile } from 'ogi-addon/config';

export type AddonConfig = {
  securityCheck: boolean;
  port: number;
  secret?: string;
};

type AddonEvents =
  | 'connect'
  | 'disconnect'
  | 'start'
  | 'notification'
  | 'input-asked';

type AddonEventListeners = {
  connect: (connection: AddonConnection) => void;
  disconnect: (reason: string) => void;
  start: () => void;
  notification: (notification: Notification) => void;
  'input-asked': (
    title: string,
    description: string,
    configuration: ConfigurationFile,
    reply: (result: Record<string, string | number | boolean>) => void
  ) => void | Promise<void>;
};

export class AddonServer {
  private connections: Set<AddonConnection> = new Set();
  private clients: Map<string, AddonConnection> = new Map();

  private server = http.createServer();

  private deferredTasksManager: DeferredTasksManager =
    new DeferredTasksManager();
  public constructor(private readonly config: AddonConfig) {
    // create a random secret if not provided
    if (config.securityCheck && !config.secret) {
      config.secret = `${Math.floor(new Date().getTime() + Math.random() * 10000)}-${Math.floor(Math.random() * 10000)}`;
    }
  }

  private eventEmitter = new EventEmitter();

  public emit<T extends AddonEvents>(
    event: T,
    ...args: Parameters<AddonEventListeners[T]>
  ): this {
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

  public on<T extends AddonEvents>(
    event: T,
    listener: AddonEventListeners[T]
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
    this.connections.forEach((connection) => {
      connection.ws.close();
    });
    this.clients.forEach((client) => {
      client.ws.close();
    });
    this.server.close();
    this.connections.clear();
    this.clients.clear();
  }

  public async start(): Promise<void> {
    const wss = new WebSocketServer({ server: this.server });

    wss.on('connection', (ws) => {
      const connection = new AddonConnection(ws, this.config, this);
      this.connections.add(connection);
      connection.setupWebsocket().then((success) => {
        if (!success) {
          this.connections.delete(connection);
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
