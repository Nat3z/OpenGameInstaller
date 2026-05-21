import type { RawData } from 'ws';

export type EventResponseMessage = {
  event: string;
  id?: string;
  args: unknown;
  statusError?: string;
};

export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on?(event: 'message', listener: (rawMessage: unknown) => void): unknown;
  on?(
    event: 'open' | 'close' | 'error',
    listener: (...args: unknown[]) => void
  ): unknown;
  addEventListener?(
    event: 'message',
    listener: (message: { data: unknown }) => void
  ): unknown;
  addEventListener?(
    event: 'open' | 'close' | 'error',
    listener: (...args: unknown[]) => void
  ): unknown;
};

type PendingResponse<IncomingMessage extends EventResponseMessage> = {
  responseEvent: string;
  resolve: (value: IncomingMessage) => void;
  reject: (reason?: unknown) => void;
};

type SendOptions = {
  expectResponse?: boolean;
  responseEvent?: string;
};

type MessageListener<Message extends EventResponseMessage> = (
  message: Message
) => void | Promise<void>;

export const randomMessageId = (): string =>
  Math.random().toString(36).substring(7);

const isBuffer = (value: unknown): value is Buffer => {
  const bufferConstructor = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  return !!bufferConstructor?.isBuffer(value);
};

const isBlob = (value: unknown): value is { text(): Promise<string> } => {
  return typeof value === 'object' && value !== null && 'text' in value;
};

export class EventResponseSocket<
  IncomingMessage extends EventResponseMessage,
  OutgoingMessage extends EventResponseMessage,
> {
  private pendingResponses = new Map<
    string,
    PendingResponse<IncomingMessage>
  >();
  private listeners = new Map<string, Set<MessageListener<IncomingMessage>>>();

  public constructor(
    private readonly socket: WebSocketLike,
    private readonly options: {
      responseEvent?: string;
      onInvalidMessage?: (rawMessage: unknown) => void;
    } = {}
  ) {
    if (this.socket.on) {
      this.socket.on('message', (rawMessage: unknown) => {
        void this.handleRawMessage(rawMessage);
      });
      return;
    }

    if (this.socket.addEventListener) {
      this.socket.addEventListener('message', (message) => {
        void this.handleRawMessage(message.data);
      });
      return;
    }

    throw new Error('Unsupported websocket implementation');
  }

  public parseMessage(rawMessage: unknown): IncomingMessage | undefined {
    try {
      const normalized = this.normalizeRawMessageSync(rawMessage);
      if (normalized === undefined) return undefined;
      return JSON.parse(normalized) as IncomingMessage;
    } catch {
      return undefined;
    }
  }

  public on<Event extends IncomingMessage['event']>(
    event: Event,
    listener: MessageListener<Extract<IncomingMessage, { event: Event }>>
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as MessageListener<IncomingMessage>);
    this.listeners.set(event, listeners);

    return () => this.off(event, listener);
  }

  public off<Event extends IncomingMessage['event']>(
    event: Event,
    listener: MessageListener<Extract<IncomingMessage, { event: Event }>>
  ): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;

    listeners.delete(listener as MessageListener<IncomingMessage>);
    if (listeners.size === 0) {
      this.listeners.delete(event);
    }
  }

  public resolveIncomingResponse(message: IncomingMessage): boolean {
    if (!message.id) {
      return false;
    }

    const pending = this.pendingResponses.get(message.id);
    if (!pending || message.event !== pending.responseEvent) {
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

  private async handleRawMessage(rawMessage: unknown): Promise<void> {
    const message = await this.parseRawMessage(rawMessage);
    if (!message) {
      this.options.onInvalidMessage?.(rawMessage);
      return;
    }

    if (this.resolveIncomingResponse(message)) return;

    const listeners = this.listeners.get(message.event);
    if (!listeners) return;

    for (const listener of [...listeners]) {
      await listener(message);
    }
  }

  private async parseRawMessage(
    rawMessage: unknown
  ): Promise<IncomingMessage | undefined> {
    try {
      const normalized = await this.normalizeRawMessage(rawMessage);
      if (normalized === undefined) return undefined;
      return JSON.parse(normalized) as IncomingMessage;
    } catch {
      return undefined;
    }
  }

  private normalizeRawMessageSync(rawMessage: unknown): string | undefined {
    if (typeof rawMessage === 'string') return rawMessage;
    if (isBuffer(rawMessage)) return rawMessage.toString();
    if (rawMessage instanceof ArrayBuffer) {
      return new TextDecoder().decode(rawMessage);
    }
    if (ArrayBuffer.isView(rawMessage)) {
      const view = rawMessage;
      return new TextDecoder().decode(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      );
    }
    if (Array.isArray(rawMessage)) {
      return rawMessage
        .map((message) => this.normalizeRawMessageSync(message))
        .join('');
    }
    return undefined;
  }

  private async normalizeRawMessage(
    rawMessage: unknown
  ): Promise<string | undefined> {
    const syncNormalized = this.normalizeRawMessageSync(rawMessage);
    if (syncNormalized !== undefined) return syncNormalized;
    if (isBlob(rawMessage)) return rawMessage.text();
    return undefined;
  }

  public send(
    message: OutgoingMessage,
    options: SendOptions = {}
  ): Promise<IncomingMessage> {
    const expectResponse = options.expectResponse ?? true;

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

      const responseEvent =
        options.responseEvent ?? this.options.responseEvent ?? 'response';

      if (expectResponse && message.id) {
        this.pendingResponses.set(message.id, {
          responseEvent,
          resolve,
          reject,
        });
        return;
      }

      resolve({
        event: responseEvent,
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
