import { Data } from 'effect';
import type { WireError } from './envelope';

/**
 * The one error a client sees. `_tag` carries the server-side error name
 * (e.g. `GameNotFound`, `MethodNotFound`) so callers can still branch on it.
 */
export class ProtocolError extends Data.TaggedError('ProtocolError')<{
  readonly tag: string;
  readonly message: string;
}> {
  static fromWire(error: WireError): ProtocolError {
    return new ProtocolError({ tag: error._tag, message: error.message });
  }
}

/** Tags the server itself produces, independent of any service. */
export const ProtocolErrorTags = {
  /** Frame was not JSON or not a known envelope. */
  BadFrame: 'BadFrame',
  /** First frame was not `hello`, or the token was wrong. */
  Unauthorized: 'Unauthorized',
  /** Client speaks a different `PROTOCOL_VERSION`. */
  VersionMismatch: 'VersionMismatch',
  /** No registered group implements the method. */
  MethodNotFound: 'MethodNotFound',
  /** Params did not match the method schema. */
  InvalidParams: 'InvalidParams',
  /** Socket closed or never opened (client-side only). */
  Disconnected: 'Disconnected',
} as const;

/** Converts any thrown/failed value into the wire shape. */
export const toWireError = (error: unknown): WireError => {
  if (typeof error === 'object' && error !== null) {
    const tagged = error as { _tag?: unknown; message?: unknown };
    if (typeof tagged._tag === 'string') {
      return {
        _tag: tagged._tag,
        message:
          typeof tagged.message === 'string' ? tagged.message : tagged._tag,
      };
    }
    if (error instanceof Error)
      return { _tag: 'Error', message: error.message };
  }
  return { _tag: 'Error', message: String(error) };
};
