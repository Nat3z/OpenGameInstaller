import { Schema } from 'effect';

/**
 * A request/response method. Params and result are plain JSON on the wire;
 * the error channel is always {@link ProtocolError}.
 */
export type CallDef<
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
> = {
  readonly _tag: 'call';
  readonly params: P;
  readonly result: R;
};

/**
 * A subscription. The server sends one `snapshot` first, then any number of
 * `update`s until either side ends it. Reconnecting = subscribing again.
 */
export type StreamDef<
  P extends Schema.Schema.AnyNoContext,
  S extends Schema.Schema.AnyNoContext,
  U extends Schema.Schema.AnyNoContext,
> = {
  readonly _tag: 'stream';
  readonly params: P;
  readonly snapshot: S;
  readonly update: U;
};

export type MethodDef =
  | CallDef<Schema.Schema.AnyNoContext, Schema.Schema.AnyNoContext>
  | StreamDef<
      Schema.Schema.AnyNoContext,
      Schema.Schema.AnyNoContext,
      Schema.Schema.AnyNoContext
    >;

/** A named set of methods, addressed on the wire as `<group>.<method>`. */
export type Group<
  Name extends string = string,
  Methods extends Record<string, MethodDef> = Record<string, MethodDef>,
> = {
  readonly name: Name;
  readonly methods: Methods;
};

export const call = <
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
>(def: {
  readonly params: P;
  readonly result: R;
}): CallDef<P, R> => ({ _tag: 'call', ...def });

export const stream = <
  P extends Schema.Schema.AnyNoContext,
  S extends Schema.Schema.AnyNoContext,
  U extends Schema.Schema.AnyNoContext,
>(def: {
  readonly params: P;
  readonly snapshot: S;
  readonly update: U;
}): StreamDef<P, S, U> => ({ _tag: 'stream', ...def });

export const group = <
  const Name extends string,
  const Methods extends Record<string, MethodDef>,
>(
  name: Name,
  methods: Methods
): Group<Name, Methods> => ({ name, methods });

// ---- type helpers used by the client and server ---------------------------

export type Params<M extends MethodDef> = Schema.Schema.Type<M['params']>;
export type Result<M extends MethodDef> =
  M extends CallDef<any, infer R> ? Schema.Schema.Type<R> : never;
export type Snapshot<M extends MethodDef> =
  M extends StreamDef<any, infer S, any> ? Schema.Schema.Type<S> : never;
export type Update<M extends MethodDef> =
  M extends StreamDef<any, any, infer U> ? Schema.Schema.Type<U> : never;

/** Wire name of a method: `library.list`. */
export const methodName = (group: Group, method: string): string =>
  `${group.name}.${method}`;
