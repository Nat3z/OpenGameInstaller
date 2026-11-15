import type {
  CallDef,
  Group,
  MethodDef,
  Params,
  Result,
  Snapshot,
  StreamDef,
  Update,
} from '@ogi-sdk/protocol';
import type { Effect, Scope, Stream } from 'effect';

/**
 * How a host (or core itself) implements one protocol group. Handlers may
 * fail with any tagged error; the server turns it into a wire error. `R` is
 * the services the handlers need, provided once when the server is built.
 */
export type CallHandler<M extends MethodDef, R> = (
  params: Params<M>
) => Effect.Effect<Result<M>, unknown, R>;

/**
 * A subscription handler returns the snapshot and the stream of updates
 * separately, so the server can guarantee `snapshot` is sent first. The
 * update stream must be subscribed *before* the snapshot is read, or a change
 * in between is lost (see `Library.watch` for the pattern).
 */
export type StreamHandler<M extends MethodDef, R> = (
  params: Params<M>
) => Effect.Effect<
  {
    readonly snapshot: Snapshot<M>;
    readonly updates: Stream.Stream<Update<M>, unknown, R>;
  },
  unknown,
  R | Scope.Scope
>;

export type Handlers<G extends Group, R> = {
  readonly [K in keyof G['methods']]: G['methods'][K] extends CallDef<any, any>
    ? CallHandler<G['methods'][K], R>
    : G['methods'][K] extends StreamDef<any, any, any>
      ? StreamHandler<G['methods'][K], R>
      : never;
};

/** A group plus its handlers. Only implemented methods need handlers. */
export type Implementation<R = never> = {
  readonly group: Group;
  readonly handlers: Partial<
    Record<string, CallHandler<any, R> | StreamHandler<any, R>>
  >;
};

/**
 * Pairs a group with handlers. Methods left out answer `MethodNotFound`, so a
 * group can be served before every method exists (and a Rust server can later
 * forward exactly those).
 */
export const implement = <G extends Group, R>(
  group: G,
  handlers: Partial<Handlers<G, R>>
): Implementation<R> => ({
  group,
  handlers: handlers as Implementation<R>['handlers'],
});
