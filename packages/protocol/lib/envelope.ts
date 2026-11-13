import { Schema } from 'effect';

/**
 * Wire envelope for the client protocol. Every frame is one JSON object with a
 * `type` discriminator. Payloads (`params`, `result`, `snapshot`, `update`) are
 * `Unknown` here and decoded against the method's own schema, so this file is
 * the only thing a new client (Rust, Python, ...) must implement by hand.
 */

export const PROTOCOL_VERSION = 1;

/** Request ids are chosen by the client and unique per connection. */
const Id = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

/** Serializable error. `_tag` mirrors the server's tagged error. */
export const WireError = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
});
export type WireError = typeof WireError.Type;

// ---- client -> server -----------------------------------------------------

export const Hello = Schema.TaggedStruct('hello', {
  token: Schema.String,
  protocol: Schema.Number,
});

export const Call = Schema.TaggedStruct('call', {
  id: Id,
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

export const Subscribe = Schema.TaggedStruct('subscribe', {
  id: Id,
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

export const Unsubscribe = Schema.TaggedStruct('unsubscribe', { id: Id });

export const ClientMessage = Schema.Union(Hello, Call, Subscribe, Unsubscribe);
export type ClientMessage = typeof ClientMessage.Type;

// ---- server -> client -----------------------------------------------------

export const Welcome = Schema.TaggedStruct('welcome', {
  protocol: Schema.Number,
  /** Groups this server implements; clients can feature-detect with it. */
  groups: Schema.Array(Schema.String),
});

export const CallResult = Schema.TaggedStruct('result', {
  id: Id,
  result: Schema.optional(Schema.Unknown),
});

export const CallError = Schema.TaggedStruct('error', {
  id: Schema.NullOr(Id),
  error: WireError,
});

export const StreamSnapshot = Schema.TaggedStruct('snapshot', {
  id: Id,
  snapshot: Schema.Unknown,
});

export const StreamUpdate = Schema.TaggedStruct('update', {
  id: Id,
  update: Schema.Unknown,
});

/** The server ended a subscription (source finished or failed). */
export const StreamEnd = Schema.TaggedStruct('end', {
  id: Id,
  error: Schema.optional(WireError),
});

export const ServerMessage = Schema.Union(
  Welcome,
  CallResult,
  CallError,
  StreamSnapshot,
  StreamUpdate,
  StreamEnd
);
export type ServerMessage = typeof ServerMessage.Type;

/** JSON text <-> typed envelope, used by both ends of the socket. */
export const ClientFrame = Schema.parseJson(ClientMessage);
export const ServerFrame = Schema.parseJson(ServerMessage);
