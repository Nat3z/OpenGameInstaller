import { Rpc, RpcGroup, type RpcMessage } from '@effect/rpc';
import { Schema } from 'effect';

export const ELECTRON_RPC_CHANNEL = 'effect-rpc';

export interface ElectronRpcRequest {
  readonly sessionId: string;
  readonly message: RpcMessage.FromClientEncoded;
}

export const OperatingSystem = Schema.Literal(
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
  'cygwin'
);

export type OperatingSystem = typeof OperatingSystem.Type;

export class ElectronRpcError extends Schema.TaggedError<ElectronRpcError>()(
  'ElectronRpcError',
  {
    procedure: Schema.String,
    message: Schema.String,
  }
) {}

export const CallElectronProcedure = Rpc.make('CallElectronProcedure', {
  payload: {
    path: Schema.String,
    args: Schema.Array(Schema.Unknown),
  },
  success: Schema.Unknown,
  error: ElectronRpcError,
});

export const ElectronRpcs = RpcGroup.make(CallElectronProcedure);
