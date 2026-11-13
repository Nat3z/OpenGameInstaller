import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import {
  type CallDef,
  ClientFrame,
  type ClientMessage,
  type Group,
  Groups,
  type MethodDef,
  methodName,
  type Params,
  PROTOCOL_VERSION,
  ProtocolError,
  ProtocolErrorTags,
  type Result,
  ServerFrame,
  type ServerMessage,
  type Snapshot,
  type StreamDef,
  type Update,
} from '@ogi-sdk/protocol';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Mailbox,
  Option,
  Schema,
  Scope,
  Stream,
} from 'effect';

const logger = createLogger(LOGGER_PREFIXES.clientKit);

/** What a subscription yields: the snapshot once, then updates. */
export type WatchEvent<M extends MethodDef> =
  | { readonly _tag: 'Snapshot'; readonly value: Snapshot<M> }
  | { readonly _tag: 'Update'; readonly value: Update<M> };

type ParamArgs<M extends MethodDef> =
  Params<M> extends void ? [] : [params: Params<M>];

/** Typed methods for one protocol group, e.g. `client.library.list()`. */
export type GroupClient<G extends Group> = {
  readonly [K in keyof G['methods']]: G['methods'][K] extends CallDef<any, any>
    ? (
        ...args: ParamArgs<G['methods'][K]>
      ) => Effect.Effect<Result<G['methods'][K]>, ProtocolError>
    : G['methods'][K] extends StreamDef<any, any, any>
      ? (
          ...args: ParamArgs<G['methods'][K]>
        ) => Stream.Stream<WatchEvent<G['methods'][K]>, ProtocolError>
      : never;
};

export type OGIClientOptions = {
  /** e.g. `ws://127.0.0.1:7654/client` */
  readonly url: string;
  readonly token: string;
  /** Defaults to `globalThis.WebSocket` (browsers, Bun, Node 22+). */
  readonly webSocket?: new (
    url: string
  ) => WebSocket;
};

type Pending =
  | {
      readonly kind: 'call';
      readonly deferred: Deferred.Deferred<unknown, ProtocolError>;
    }
  | {
      readonly kind: 'stream';
      readonly mailbox: Mailbox.Mailbox<WatchEvent<any>, ProtocolError>;
    };

/**
 * Effect client for the OGI protocol. Every method on every group in
 * `@ogi-sdk/protocol` is available, typed from the schemas; calls the server
 * has not implemented fail with `ProtocolError({ tag: 'MethodNotFound' })`.
 */
export class EffectOGIClient {
  readonly library: GroupClient<Groups['library']>;
  readonly downloads: GroupClient<Groups['downloads']>;
  readonly prompts: GroupClient<Groups['prompts']>;
  readonly events: GroupClient<Groups['events']>;
  readonly addons: GroupClient<Groups['addons']>;

  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  private constructor(
    private readonly socket: WebSocket,
    /** Groups the server said it implements in `welcome`. */
    readonly serverGroups: ReadonlyArray<string>
  ) {
    this.library = this.groupClient(Groups.library);
    this.downloads = this.groupClient(Groups.downloads);
    this.prompts = this.groupClient(Groups.prompts);
    this.events = this.groupClient(Groups.events);
    this.addons = this.groupClient(Groups.addons);
  }

  /** Opens the socket, does the `hello` handshake, and closes with the scope. */
  static connect(
    options: OGIClientOptions
  ): Effect.Effect<EffectOGIClient, ProtocolError, Scope.Scope> {
    return Effect.acquireRelease(EffectOGIClient.open(options), (client) =>
      Effect.sync(() => client.close())
    );
  }

  private static open(
    options: OGIClientOptions
  ): Effect.Effect<EffectOGIClient, ProtocolError> {
    return Effect.async<EffectOGIClient, ProtocolError>((resume) => {
      const WebSocketImpl = options.webSocket ?? globalThis.WebSocket;
      const socket = new WebSocketImpl(options.url);
      let client: EffectOGIClient | undefined;

      socket.addEventListener('open', () => {
        socket.send(
          encodeClient({
            _tag: 'hello',
            token: options.token,
            protocol: PROTOCOL_VERSION,
          })
        );
      });
      socket.addEventListener('message', (event) => {
        const message = decodeServer(String(event.data));
        if (!message) return;
        if (!client) {
          if (message._tag === 'welcome') {
            client = new EffectOGIClient(socket, message.groups);
            resume(Effect.succeed(client));
          } else if (message._tag === 'error') {
            resume(Effect.fail(ProtocolError.fromWire(message.error)));
          }
          return;
        }
        client.receive(message);
      });
      socket.addEventListener('close', () => {
        if (client) client.failAll('Socket closed');
        else
          resume(
            Effect.fail(
              new ProtocolError({
                tag: ProtocolErrorTags.Disconnected,
                message: 'Socket closed before handshake',
              })
            )
          );
      });
      return Effect.sync(() => socket.close());
    });
  }

  close(): void {
    this.failAll('Client closed');
    this.socket.close();
  }

  private groupClient<G extends Group>(group: G): GroupClient<G> {
    const methods: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(group.methods)) {
      const method = methodName(group, name);
      methods[name] =
        def._tag === 'call'
          ? (params?: unknown) => this.call(method, def, params)
          : (params?: unknown) => this.watch(method, def, params);
    }
    return methods as GroupClient<G>;
  }

  private call(
    method: string,
    def: CallDef<any, any>,
    params: unknown
  ): Effect.Effect<unknown, ProtocolError> {
    return Effect.gen(this, function* () {
      const id = this.nextId++;
      const deferred = yield* Deferred.make<unknown, ProtocolError>();
      this.pending.set(id, { kind: 'call', deferred });
      yield* this.send({
        _tag: 'call',
        id,
        method,
        params: yield* encodeParams(def.params, params),
      });
      const raw = yield* Deferred.await(deferred).pipe(
        Effect.ensuring(Effect.sync(() => this.pending.delete(id)))
      );
      return yield* decodePayload(def.result, raw);
    });
  }

  private watch(
    method: string,
    def: StreamDef<any, any, any>,
    params: unknown
  ): Stream.Stream<WatchEvent<any>, ProtocolError> {
    return Stream.unwrapScoped(
      Effect.gen(this, function* () {
        const id = this.nextId++;
        const mailbox = yield* Mailbox.make<WatchEvent<any>, ProtocolError>();
        this.pending.set(id, { kind: 'stream', mailbox });
        // Interrupting the consumer tells the server to stop sending.
        yield* Effect.addFinalizer(() =>
          Effect.gen(this, function* () {
            if (!this.pending.delete(id)) return;
            yield* this.send({ _tag: 'unsubscribe', id }).pipe(Effect.ignore);
          })
        );
        yield* this.send({
          _tag: 'subscribe',
          id,
          method,
          params: yield* encodeParams(def.params, params),
        });
        return Mailbox.toStream(mailbox).pipe(
          Stream.mapEffect(
            (event): Effect.Effect<WatchEvent<any>, ProtocolError> =>
              decodePayload(
                event._tag === 'Snapshot' ? def.snapshot : def.update,
                event.value
              ).pipe(Effect.map((value) => ({ _tag: event._tag, value })))
          )
        );
      })
    );
  }

  private send(message: ClientMessage): Effect.Effect<void, ProtocolError> {
    return Effect.try({
      try: () => this.socket.send(encodeClient(message)),
      catch: () =>
        new ProtocolError({
          tag: ProtocolErrorTags.Disconnected,
          message: 'Socket is not open',
        }),
    });
  }

  private receive(message: ServerMessage): void {
    if (message._tag === 'welcome') return;
    if (message.id === null) {
      logger.sync.warn('[ogi-client] server error', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (pending.kind === 'call') {
      if (message._tag === 'result')
        Deferred.unsafeDone(pending.deferred, Effect.succeed(message.result));
      else if (message._tag === 'error')
        Deferred.unsafeDone(
          pending.deferred,
          Effect.fail(ProtocolError.fromWire(message.error))
        );
      return;
    }
    switch (message._tag) {
      case 'snapshot':
        pending.mailbox.unsafeOffer({
          _tag: 'Snapshot',
          value: message.snapshot,
        });
        return;
      case 'update':
        pending.mailbox.unsafeOffer({ _tag: 'Update', value: message.update });
        return;
      case 'end':
        this.pending.delete(message.id);
        pending.mailbox.unsafeDone(
          message.error
            ? Exit.fail(ProtocolError.fromWire(message.error))
            : Exit.void
        );
        return;
      case 'error':
        this.pending.delete(message.id);
        pending.mailbox.unsafeDone(
          Exit.fail(ProtocolError.fromWire(message.error))
        );
        return;
    }
  }

  private failAll(reason: string): void {
    const error = new ProtocolError({
      tag: ProtocolErrorTags.Disconnected,
      message: reason,
    });
    for (const pending of this.pending.values()) {
      if (pending.kind === 'call')
        Deferred.unsafeDone(pending.deferred, Exit.fail(error));
      else pending.mailbox.unsafeDone(Exit.fail(error));
    }
    this.pending.clear();
  }
}

const encodeClient = Schema.encodeSync(ClientFrame);
const decodeServer = (text: string): ServerMessage | undefined =>
  Option.getOrUndefined(Schema.decodeOption(ServerFrame)(text));

const encodeParams = (schema: Schema.Schema.AnyNoContext, params: unknown) =>
  Schema.encode(schema)(params).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolError({
          tag: ProtocolErrorTags.InvalidParams,
          message: cause.message,
        })
    )
  );

const decodePayload = (schema: Schema.Schema.AnyNoContext, raw: unknown) =>
  Schema.decodeUnknown(schema)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolError({
          tag: ProtocolErrorTags.BadFrame,
          message: cause.message,
        })
    )
  );

// ---- Promise API ----------------------------------------------------------

/** Typed methods for one group, Promise-shaped for non-Effect frontends. */
export type PromiseGroupClient<G extends Group> = {
  readonly [K in keyof G['methods']]: G['methods'][K] extends CallDef<any, any>
    ? (...args: ParamArgs<G['methods'][K]>) => Promise<Result<G['methods'][K]>>
    : G['methods'][K] extends StreamDef<any, any, any>
      ? (
          ...args: [
            ...ParamArgs<G['methods'][K]>,
            onEvent: (event: WatchEvent<G['methods'][K]>) => void,
          ]
        ) => () => void
      : never;
};

/**
 * Promise client: same methods, no Effect in the caller's code. Streams take
 * a callback and return an unsubscribe function.
 *
 *   const ogi = await OGIClient.connect({ url, token });
 *   const games = await ogi.library.list();
 *   const stop = ogi.library.watch((event) => render(event));
 */
export class OGIClient {
  readonly library: PromiseGroupClient<Groups['library']>;
  readonly downloads: PromiseGroupClient<Groups['downloads']>;
  readonly prompts: PromiseGroupClient<Groups['prompts']>;
  readonly events: PromiseGroupClient<Groups['events']>;
  readonly addons: PromiseGroupClient<Groups['addons']>;

  private constructor(
    readonly effect: EffectOGIClient,
    private readonly scope: Scope.CloseableScope
  ) {
    this.library = this.wrap(Groups.library, effect.library);
    this.downloads = this.wrap(Groups.downloads, effect.downloads);
    this.prompts = this.wrap(Groups.prompts, effect.prompts);
    this.events = this.wrap(Groups.events, effect.events);
    this.addons = this.wrap(Groups.addons, effect.addons);
  }

  static async connect(options: OGIClientOptions): Promise<OGIClient> {
    const scope = Effect.runSync(Scope.make());
    const effect = await run(
      EffectOGIClient.connect(options).pipe(Scope.extend(scope))
    );
    return new OGIClient(effect, scope);
  }

  async close(): Promise<void> {
    await Effect.runPromise(Scope.close(this.scope, Exit.void));
  }

  private wrap<G extends Group>(
    group: G,
    client: GroupClient<G>
  ): PromiseGroupClient<G> {
    const methods: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(group.methods)) {
      const method = (
        client as unknown as Record<string, (...a: unknown[]) => unknown>
      )[name]!;
      methods[name] =
        def._tag === 'call'
          ? (...args: unknown[]) =>
              run(method(...args) as Effect.Effect<unknown, ProtocolError>)
          : (...args: unknown[]) => {
              const onEvent = args.pop() as (event: unknown) => void;
              const fiber = Effect.runFork(
                (method(...args) as Stream.Stream<unknown, ProtocolError>).pipe(
                  Stream.runForEach((event) =>
                    Effect.sync(() => onEvent(event))
                  ),
                  Effect.catchAll((error) =>
                    logger.warn(
                      `[ogi-client] ${group.name}.${name} ended`,
                      error
                    )
                  )
                )
              );
              return () => {
                Effect.runFork(Fiber.interrupt(fiber));
              };
            };
    }
    return methods as PromiseGroupClient<G>;
  }
}

/** Like `Effect.runPromise`, but rejects with the ProtocolError itself. */
const run = <A>(effect: Effect.Effect<A, ProtocolError>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    throw Option.isSome(failure) ? failure.value : Cause.squash(exit.cause);
  });

// Re-exported so frontends only need client-kit.
export { ProtocolError };
