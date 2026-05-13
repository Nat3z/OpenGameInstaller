import { WebSocket } from 'ws';

export type EventResponseMessage = {
  event: string;
  id?: string;
  args: unknown;
  statusError?: string;
};

type PendingResponse<IncomingMessage extends EventResponseMessage> = {
  resolve: (value: IncomingMessage) => void;
  reject: (reason?: unknown) => void;
};

export const randomMessageId = (): string =>
  Math.random().toString(36).substring(7);

export class EventResponseSocket<
  IncomingMessage extends EventResponseMessage,
  OutgoingMessage extends EventResponseMessage,
> {
  private pendingResponses = new Map<
    string,
    PendingResponse<IncomingMessage>
  >();

  public constructor(
    private readonly socket: WebSocket,
    private readonly options: {
      responseEvent?: string;
    } = {}
  ) {}

  public parseMessage(
    rawMessage: string | Buffer
  ): IncomingMessage | undefined {
    try {
      return JSON.parse(rawMessage.toString()) as IncomingMessage;
    } catch {
      return undefined;
    }
  }

  public resolveIncomingResponse(message: IncomingMessage): boolean {
    const responseEvent = this.options.responseEvent ?? 'response';
    if (message.event !== responseEvent || !message.id) {
      return false;
    }

    const pending = this.pendingResponses.get(message.id);
    if (!pending) {
      return false;
    }

    this.pendingResponses.delete(message.id);
    if (message.statusError) {
      pending.reject(new Error(message.statusError));
      return true;
    }

    pending.resolve(message);
    return true;
  }

  public send(
    message: OutgoingMessage,
    expectResponse: boolean = true
  ): Promise<IncomingMessage> {
    if (expectResponse) {
      message.id = message.id ?? randomMessageId();
    }

    return new Promise((resolve, reject) => {
      // CLOSED state is 3
      if (this.socket.readyState === 3) {
        reject(new Error('Websocket closed'));
        return;
      }

      this.socket.send(JSON.stringify(message));

      if (expectResponse && message.id) {
        this.pendingResponses.set(message.id, { resolve, reject });
        return;
      }

      resolve({
        event: this.options.responseEvent ?? 'response',
        args: 'OK',
      } as IncomingMessage);
    });
  }

  public rejectPendingResponses(reason: string): void {
    for (const pending of this.pendingResponses.values()) {
      pending.reject(new Error(reason));
    }
    this.pendingResponses.clear();
  }
}
