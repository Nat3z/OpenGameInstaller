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

export const GetOperatingSystem = Rpc.make('GetOperatingSystem', {
  success: OperatingSystem,
});

export const ElectronRpcs = RpcGroup.make(GetOperatingSystem);
