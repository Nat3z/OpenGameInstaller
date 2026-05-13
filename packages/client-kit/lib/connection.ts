import { EventResponseSocket } from '@ogi-sdk/connect';
import type { WebsocketMessageClient, WebsocketMessageServer } from 'ogi-addon';
import { WebSocket } from 'ws';

type ConnectionOptions = {
  url: string;
  secret: string;
};

export class Connection {
  private socket: WebSocket;
  private transport: EventResponseSocket<
    WebsocketMessageClient,
    WebsocketMessageServer
  >;

  constructor(options: ConnectionOptions) {
    this.socket = new WebSocket(options.url);
    this.transport = new EventResponseSocket(this.socket);
    this.connect();
  }

  private async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.on('open', () => {
        resolve();
      });
    });
  }
}
