import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import {
  ClientFrame,
  type ClientMessage,
  methodName,
  PROTOCOL_VERSION,
  ProtocolErrorTags,
  ServerFrame,
  type ServerMessage,
  toWireError,
  type WireError,
} from '@ogi-sdk/protocol';
import {
  Effect,
  ExecutionStrategy,
  Exit,
  FiberMap,
  Runtime,
  Schema,
  Scope,
  Stream,
} from 'effect';
import type { Implementation } from './router';
import type { ServerSocket } from './socket';

const logger = createLogger(LOGGER_PREFIXES.core);

type Route<R> = {
  readonly kind: 'call' | 'stream';
  readonly def: Implementation<R>['group']['methods'][string];
  readonly handler: NonNullable<Implementation<R>['handlers'][string]>;
};

export type OGIServerOptions<Impls extends ReadonlyArray<Implementation<any>>> =
  {
    /** Shared secret every client must send in `hello`. */
    readonly token: string;
    readonly implementations: Impls;
  };

/** Union of the services every implementation needs. */
export type ImplementationsContext<
  Impls extends ReadonlyArray<Implementation<any>>,
> = Impls[number] extends Implementation<infer R> ? R : never;

/**
 * Serves the client protocol over any {@link ServerSocket}. One instance
 * handles every connection; each connection gets its own scope, so closing
 * the socket interrupts its in-flight calls and subscriptions.
 */
export class OGIServer<R> {
  private constructor(
    private readonly token: string,
    private readonly routes: ReadonlyMap<string, Route<R>>,
    private readonly groups: ReadonlyArray<string>,
    private readonly runtime: Runtime.Runtime<R>,
    private readonly scope: Scope.Scope
  ) {}

  /** Builds the router. Requires the handlers' services and a Scope. */
  static make<const Impls extends ReadonlyArray<Implementation<any>>>(
    options: OGIServerOptions<Impls>
  ): Effect.Effect<
    OGIServer<ImplementationsContext<Impls>>,
    never,
    ImplementationsContext<Impls> | Scope.Scope
  > {
    type R = ImplementationsContext<Impls>;
    return Effect.gen(function* () {
      const routes = new Map<string, Route<R>>();
      for (const { group, handlers } of options.implementations) {
        for (const [method, handler] of Object.entries(handlers)) {
          const def = group.methods[method];
          if (!def || !handler) continue;
          routes.set(methodName(group, method), {
            kind: def._tag,
            def,
            handler,
          });
        }
      }
      return new OGIServer(
        options.token,
        routes,
        options.implementations.map(({ group }) => group.name),
        yield* Effect.runtime<R>(),
        yield* Effect.scope
      );
    });
  }

  /** Attach a freshly accepted socket. Safe to call from any callback. */
  readonly serve = (socket: ServerSocket): void => {
    Runtime.runFork(this.runtime)(
      this.connection(socket).pipe(Scope.extend(this.scope))
    );
  };

  private connection(
    socket: ServerSocket
  ): Effect.Effect<void, never, R | Scope.Scope> {
    return Effect.gen(this, function* () {
      const scope = yield* Scope.fork(
        yield* Effect.scope,
        ExecutionStrategy.sequential
      );
      // One fiber per in-flight call or subscription, keyed by request id.
      const fibers = yield* FiberMap.make<number>().pipe(Scope.extend(scope));
      const run = Runtime.runFork(this.runtime);
      let authed = false;

      const send = (message: ServerMessage): Effect.Effect<void> =>
        Schema.encode(ServerFrame)(message).pipe(
          Effect.flatMap((text) => Effect.try(() => socket.send(text))),
          Effect.catchAll((error) =>
            logger.warn('[core] could not send frame', error)
          )
        );
      const fail = (id: number | null, error: WireError) =>
        send({ _tag: 'error', id, error });
      const reject = (tag: string, message: string) =>
        fail(null, { _tag: tag, message }).pipe(
          Effect.andThen(Effect.sync(() => socket.close(1008, message)))
        );

      const handle = (
        message: ClientMessage
      ): Effect.Effect<void, never, R> => {
        if (!authed) {
          if (message._tag !== 'hello' || message.token !== this.token) {
            return reject(ProtocolErrorTags.Unauthorized, 'Invalid token');
          }
          if (message.protocol !== PROTOCOL_VERSION) {
            return reject(
              ProtocolErrorTags.VersionMismatch,
              `Server speaks protocol ${PROTOCOL_VERSION}, client sent ${message.protocol}`
            );
          }
          authed = true;
          return send({
            _tag: 'welcome',
            protocol: PROTOCOL_VERSION,
            groups: this.groups,
          });
        }
        switch (message._tag) {
          case 'hello':
            return Effect.void;
          case 'unsubscribe':
            return FiberMap.remove(fibers, message.id);
          case 'call':
          case 'subscribe': {
            const route = this.routes.get(message.method);
            const expected = message._tag === 'call' ? 'call' : 'stream';
            if (!route || route.kind !== expected) {
              return fail(message.id, {
                _tag: ProtocolErrorTags.MethodNotFound,
                message: `No ${expected} named ${message.method}`,
              });
            }
            const work =
              message._tag === 'call'
                ? this.runCall(route, message.id, message.params, send)
                : this.runStream(route, message.id, message.params, send);
            return FiberMap.run(fibers, message.id)(work).pipe(Effect.asVoid);
          }
        }
      };

      socket.onMessage((text) => {
        run(
          Schema.decode(ClientFrame)(text).pipe(
            Effect.matchEffect({
              onFailure: () =>
                fail(null, {
                  _tag: ProtocolErrorTags.BadFrame,
                  message: 'Frame is not a valid client message',
                }),
              onSuccess: handle,
            })
          )
        );
      });
      socket.onClose(() => {
        run(Scope.close(scope, Exit.void));
      });
    });
  }

  private runCall(
    route: Route<R>,
    id: number,
    rawParams: unknown,
    send: (message: ServerMessage) => Effect.Effect<void>
  ): Effect.Effect<void, never, R> {
    const def = route.def;
    if (def._tag !== 'call') return Effect.void;
    return Effect.gen(function* () {
      const params = yield* decodeParams(def.params, rawParams);
      const value = yield* (
        route.handler as (p: unknown) => Effect.Effect<unknown, unknown, R>
      )(params);
      const result = yield* Schema.encode(def.result)(value);
      yield* send({ _tag: 'result', id, result });
    }).pipe(
      Effect.catchAll((error) =>
        send({ _tag: 'error', id, error: toWireError(error) })
      )
    );
  }

  private runStream(
    route: Route<R>,
    id: number,
    rawParams: unknown,
    send: (message: ServerMessage) => Effect.Effect<void>
  ): Effect.Effect<void, never, R> {
    const def = route.def;
    if (def._tag !== 'stream') return Effect.void;
    return Effect.scoped(
      Effect.gen(function* () {
        const params = yield* decodeParams(def.params, rawParams);
        const { snapshot, updates } = yield* (
          route.handler as (
            p: unknown
          ) => Effect.Effect<
            { snapshot: unknown; updates: Stream.Stream<unknown, unknown, R> },
            unknown,
            R | Scope.Scope
          >
        )(params);
        yield* send({
          _tag: 'snapshot',
          id,
          snapshot: yield* Schema.encode(def.snapshot)(snapshot),
        });
        yield* updates.pipe(
          Stream.mapEffect((update) => Schema.encode(def.update)(update)),
          Stream.runForEach((update) => send({ _tag: 'update', id, update }))
        );
        yield* send({ _tag: 'end', id });
      })
    ).pipe(
      Effect.catchAll((error) =>
        send({ _tag: 'end', id, error: toWireError(error) })
      )
    );
  }
}

const decodeParams = (
  schema: Schema.Schema.AnyNoContext,
  raw: unknown
): Effect.Effect<unknown, WireError> =>
  Schema.decodeUnknown(schema)(raw).pipe(
    Effect.mapError((cause) => ({
      _tag: ProtocolErrorTags.InvalidParams,
      message: cause.message,
    }))
  );
