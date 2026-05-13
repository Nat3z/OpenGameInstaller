import { WebSocket } from 'ws';
import { EventResponseSocket, type WebsocketMessage } from '@ogi-sdk/connect';
import type { WebsocketMessageServer } from 'ogi-addon';
import type { AddonServer } from './server';

export class ClientConnection {
  private socket: WebSocket;
  private transport: EventResponseSocket<
    WebsocketMessageClient<OGIClientSDKSentEvent>,
    WebsocketMessageServer
  >;
  private server: AddonServer;

  constructor(socket: WebSocket, server: AddonServer) {
    this.socket = socket;
    this.server = server;
    this.transport = new EventResponseSocket(this.socket);

    this.setupWebsocket();
  }

  private async setupWebsocket(): Promise<void> {
    // after the socket is ready
    await new Promise<void>((resolve) => {
      this.socket.on('open', () => {
        resolve();
      });
    });

    this.socket.on('message', (message: string | Buffer) => {
      const data = this.transport.parseMessage(message);
      if (!data) {
        console.error('Failed to parse websocket message');
        this.socket.close(1008, 'Invalid JSON message');
        return;
      }

      if (this.transport.resolveIncomingResponse(data)) return;

      // then, send this to the internal
    });
  }
}
