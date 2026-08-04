import { RpcClient, RpcClientError, type RpcMessage } from '@effect/rpc';
import { Effect } from 'effect';
import { ElectronRpcs, type OperatingSystem } from '@/lib/electron-rpc.js';

export interface ElectronRpcClient {
  getOperatingSystem: () => Promise<OperatingSystem>;
}

export function makeElectronRpcClient(
  invoke: (
    request: RpcMessage.FromClientEncoded
  ) => Promise<RpcMessage.FromServerEncoded | undefined>
): ElectronRpcClient {
  const protocol = RpcClient.Protocol.make((writeResponse) =>
    Effect.succeed({
      send: (request: RpcMessage.FromClientEncoded) =>
        Effect.tryPromise({
          try: () => invoke(request),
          catch: (cause) =>
            new RpcClientError.RpcClientError({
              reason: 'Protocol',
              message: 'Electron IPC request failed',
              cause,
            }),
        }).pipe(
          Effect.flatMap((response) =>
            response === undefined ? Effect.void : writeResponse(response)
          )
        ),
      supportsAck: false,
      supportsTransferables: false,
    })
  );

  return {
    getOperatingSystem: () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const protocolService = yield* protocol;
            const client = yield* RpcClient.make(ElectronRpcs).pipe(
              Effect.provideService(RpcClient.Protocol, protocolService)
            );
            return yield* client.GetOperatingSystem();
          })
        )
      ),
  };
}
