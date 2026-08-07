import { NetworkError, ValidationError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  PubSub,
  Random,
  Schema,
  Scope,
  Stream,
} from 'effect';

const logger = createLogger(LOGGER_PREFIXES.connection);

export const EventResponseMessageSchema = Schema.Struct({
  event: Schema.String,
  id: Schema.optional(Schema.String),
  args: Schema.Unknown,
  statusError: Schema.optional(Schema.String),
});

export type EventResponseMessage = {
  readonly event: string;
  id?: string;
  readonly args: unknown;
  readonly statusError?: string;
};

export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on?(event: 'message', listener: (rawMessage: unknown) => void): unknown;
  on?(
    event: 'open' | 'close' | 'error',
    listener: (...args: unknown[]) => void
  ): unknown;
  addEventListener?(
    event: 'message',
    listener: (message: { readonly data: unknown }) => void
  ): unknown;
  addEventListener?(
    event: 'open' | 'close' | 'error',
    listener: (...args: unknown[]) => void
  ): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeEventListener?(
    event: 'message',
    listener: (message: { readonly data: unknown }) => void
  ): unknown;
  removeEventListener?(
    event: 'open' | 'close' | 'error',
    listener: (...args: unknown[]) => void
  ): unknown;
};

type PendingResponse<IncomingMessage extends EventResponseMessage> = {
  readonly responseEvent: string;
  readonly deferred: Deferred.Deferred<IncomingMessage, NetworkError>;
};

export type SendOptions = {
  readonly expectResponse?: boolean;
  readonly responseEvent?: string;
};

export type EventResponseSocketOptions = {
  readonly responseEvent?: string;
  readonly onInvalidMessage?: (
    rawMessage: unknown
  ) => Effect.Effect<void, never>;
};

/** Generates a correlation id through Effect's Random service. */
export const randomMessageId = (): Effect.Effect<string> =>
  Random.next.pipe(Effect.map((value) => value.toString(36).substring(2, 9)));

const isBuffer = (value: unknown): value is Buffer => {
  const bufferConstructor = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  return !!bufferConstructor?.isBuffer(value);
};

const isBlob = (value: unknown): value is { text(): Promise<string> } =>
  typeof value === 'object' &&
  value !== null &&
  'text' in value &&
  typeof value.text === 'function';

/**
 * Effect-based request/response transport over a WebSocket-like value.
 *
 * Incoming messages are published through {@link messages}; event handlers are
 * stream consumers, and correlated requests wait on Effect Deferred values.
 */
export class EventResponseSocket<
  IncomingMessage extends EventResponseMessage,
  OutgoingMessage extends EventResponseMessage,
> {
  private readonly pendingResponses = new Map<
    string,
    PendingResponse<IncomingMessage>
  >();

  public readonly messages: Stream.Stream<IncomingMessage>;

  private constructor(
    private readonly socket: WebSocketLike,
    private readonly messagePubSub: PubSub.PubSub<IncomingMessage>,
    private readonly scope: Scope.CloseableScope,
    private readonly options: EventResponseSocketOptions
  ) {
    this.messages = Stream.fromPubSub(messagePubSub);
  }

  /** Allocates and attaches a transport without performing work in a constructor. */
  public static make<
    Incoming extends EventResponseMessage,
    Outgoing extends EventResponseMessage,
  >(
    socket: WebSocketLike,
    options: EventResponseSocketOptions = {}
  ): Effect.Effect<EventResponseSocket<Incoming, Outgoing>, NetworkError> {
    return Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<Incoming>();
      const scope = yield* Scope.make();
      const transport = new EventResponseSocket<Incoming, Outgoing>(
        socket,
        pubsub,
        scope,
        options
      );
      yield* transport
        .attach()
        .pipe(Effect.tapError(() => Scope.close(scope, Exit.void)));
      return transport;
    });
  }

  /** Parses and validates one websocket frame. */
  public parseMessage(
    rawMessage: unknown
  ): Effect.Effect<IncomingMessage, ValidationError> {
    return Effect.gen(this, function* () {
      const normalized = yield* this.normalizeRawMessage(rawMessage);
      const json = yield* Effect.try({
        try: () => JSON.parse(normalized) as unknown,
        catch: (cause) =>
          new ValidationError({
            message: `Invalid websocket JSON: ${String(cause)}`,
          }),
      });
      const parsed = yield* Schema.decodeUnknown(EventResponseMessageSchema)(
        json
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ValidationError({
              message: `Invalid websocket message: ${String(cause)}`,
            })
        )
      );
      return parsed as IncomingMessage;
    });
  }

  /** Returns a typed stream containing only one protocol event. */
  public stream<Event extends IncomingMessage['event']>(
    event: Event
  ): Stream.Stream<Extract<IncomingMessage, { readonly event: Event }>> {
    return this.messages.pipe(
      Stream.filter(
        (
          message
        ): message is Extract<IncomingMessage, { readonly event: Event }> =>
          message.event === event
      )
    );
  }

  /** Forks a listener supervised by this transport's lifetime. */
  public on<Event extends IncomingMessage['event'], E>(
    event: Event,
    listener: (
      message: Extract<IncomingMessage, { readonly event: Event }>
    ) => Effect.Effect<void, E>
  ): Effect.Effect<Fiber.RuntimeFiber<void, E>> {
    return this.stream(event).pipe(
      Stream.runForEach(listener),
      Effect.forkIn(this.scope)
    );
  }

  /** Registers cleanup to run when this transport shuts down. */
  public addFinalizer(finalizer: Effect.Effect<void>): Effect.Effect<void> {
    return Scope.addFinalizer(this.scope, finalizer);
  }

  /** Forks any Effect under this transport's lifetime. */
  public fork<A, E>(
    effect: Effect.Effect<A, E>
  ): Effect.Effect<Fiber.RuntimeFiber<A, E>> {
    return Effect.forkIn(effect, this.scope);
  }

  /** Runs an external websocket callback under this transport's supervision. */
  public run<E>(effect: Effect.Effect<void, E>): void {
    Effect.runFork(
      this.fork(
        logger.observe(
          effect.pipe(
            Effect.tapError((error) =>
              logger.error('WebSocket callback failed:', error)
            )
          )
        )
      )
    );
  }

  /** Completes a matching request Deferred when a response arrives. */
  public resolveIncomingResponse(
    message: IncomingMessage
  ): Effect.Effect<boolean> {
    return Effect.gen(this, function* () {
      if (!message.id) return false;

      const pending = this.pendingResponses.get(message.id);
      if (!pending || message.event !== pending.responseEvent) return false;

      this.pendingResponses.delete(message.id);
      if (message.statusError) {
        yield* Deferred.fail(
          pending.deferred,
          new NetworkError({ message: message.statusError })
        );
      } else {
        yield* Deferred.succeed(pending.deferred, message);
      }
      return true;
    });
  }

  /** Sends a protocol message and optionally waits for its correlated response. */
  public send(
    message: OutgoingMessage,
    options: SendOptions = {}
  ): Effect.Effect<IncomingMessage, NetworkError | ValidationError> {
    return Effect.gen(this, function* () {
      const expectResponse = options.expectResponse ?? true;
      if (expectResponse && !message.id) {
        message.id = yield* randomMessageId();
      }

      if (this.socket.readyState !== 1) {
        return yield* Effect.fail(
          new NetworkError({
            message: `Websocket is not open (readyState: ${this.socket.readyState})`,
          })
        );
      }

      const responseEvent =
        options.responseEvent ?? this.options.responseEvent ?? 'response';
      const deferred = expectResponse
        ? yield* Deferred.make<IncomingMessage, NetworkError>()
        : undefined;

      if (deferred && message.id) {
        this.pendingResponses.set(message.id, { responseEvent, deferred });
      }

      const serialized = yield* Effect.try({
        try: () => JSON.stringify(message),
        catch: (cause) =>
          new ValidationError({
            message: `Unable to serialize websocket message: ${String(cause)}`,
          }),
      });

      yield* Effect.try({
        try: () => this.socket.send(serialized),
        catch: (cause) =>
          new NetworkError({
            message: `Unable to send websocket message: ${String(cause)}`,
          }),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (message.id) this.pendingResponses.delete(message.id);
          })
        )
      );

      if (!deferred || !message.id) {
        return {
          event: responseEvent,
          args: 'OK',
        } as IncomingMessage;
      }

      const messageId = message.id;
      return yield* Deferred.await(deferred).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.pendingResponses.delete(messageId);
          })
        )
      );
    });
  }

  /** Fails every request currently waiting for a response. */
  public rejectPendingResponses(reason: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const error = new NetworkError({ message: reason });
      for (const pending of this.pendingResponses.values()) {
        yield* Deferred.fail(pending.deferred, error);
      }
      this.pendingResponses.clear();
    });
  }

  /** Shuts down streams, pending requests, and the underlying socket. */
  public shutdown(
    reason = 'Connection closed'
  ): Effect.Effect<void, NetworkError> {
    return Effect.gen(this, function* () {
      yield* this.rejectPendingResponses(reason);
      yield* PubSub.shutdown(this.messagePubSub);
      yield* Scope.close(this.scope, Exit.void);
      yield* Effect.try({
        try: () => this.socket.close(),
        catch: (cause) =>
          new NetworkError({
            message: `Unable to close websocket: ${String(cause)}`,
          }),
      });
    });
  }

  private attach(): Effect.Effect<void, NetworkError> {
    return Effect.gen(this, function* () {
      const runMessage = (rawMessage: unknown): void => {
        this.run(this.handleRawMessage(rawMessage));
      };
      const browserMessage = (message: { readonly data: unknown }): void =>
        runMessage(message.data);

      const removeListener = yield* Effect.try({
        try: () => {
          if (this.socket.on) {
            this.socket.on('message', runMessage);
            return () => this.socket.off?.('message', runMessage);
          }
          if (this.socket.addEventListener) {
            this.socket.addEventListener('message', browserMessage);
            return () =>
              this.socket.removeEventListener?.('message', browserMessage);
          }
          throw new TypeError('Unsupported websocket implementation');
        },
        catch: (cause) =>
          new NetworkError({
            message: `Unable to attach websocket listener: ${String(cause)}`,
          }),
      });

      yield* Scope.addFinalizer(
        this.scope,
        Effect.sync(() => {
          removeListener();
        })
      );
    });
  }

  private handleRawMessage(rawMessage: unknown): Effect.Effect<void> {
    return this.parseMessage(rawMessage).pipe(
      Effect.matchEffect({
        onFailure: () =>
          this.options.onInvalidMessage?.(rawMessage) ?? Effect.void,
        onSuccess: (message) =>
          Effect.gen(this, function* () {
            const resolved = yield* this.resolveIncomingResponse(message);
            if (!resolved) yield* PubSub.publish(this.messagePubSub, message);
          }),
      })
    );
  }

  private normalizeRawMessage(
    rawMessage: unknown
  ): Effect.Effect<string, ValidationError> {
    return Effect.gen(this, function* () {
      const syncNormalized = yield* Effect.try({
        try: () => this.normalizeRawMessageSync(rawMessage),
        catch: (cause) =>
          new ValidationError({
            message: `Unable to decode websocket frame: ${String(cause)}`,
          }),
      });
      if (syncNormalized !== undefined) return syncNormalized;

      if (isBlob(rawMessage)) {
        return yield* Effect.tryPromise({
          try: () => rawMessage.text(),
          catch: (cause) =>
            new ValidationError({
              message: `Unable to read websocket Blob: ${String(cause)}`,
            }),
        });
      }

      return yield* Effect.fail(
        new ValidationError({ message: 'Unsupported websocket frame type' })
      );
    });
  }

  private normalizeRawMessageSync(rawMessage: unknown): string | undefined {
    if (typeof rawMessage === 'string') return rawMessage;
    if (isBuffer(rawMessage)) return rawMessage.toString();
    if (rawMessage instanceof ArrayBuffer) {
      return new TextDecoder().decode(rawMessage);
    }
    if (ArrayBuffer.isView(rawMessage)) {
      return new TextDecoder().decode(
        new Uint8Array(
          rawMessage.buffer,
          rawMessage.byteOffset,
          rawMessage.byteLength
        )
      );
    }
    if (Array.isArray(rawMessage)) {
      const pieces = rawMessage.map((piece) =>
        this.normalizeRawMessageSync(piece)
      );
      return pieces.every((piece) => piece === undefined)
        ? undefined
        : pieces.map((piece) => piece ?? '').join('');
    }
    return undefined;
  }
}
