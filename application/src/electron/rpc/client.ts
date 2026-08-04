import { RpcClient, RpcClientError, type RpcMessage } from '@effect/rpc';
import { Effect, Exit, Scope } from 'effect';
import {
  type ElectronRouter,
  type ElectronRouterClient,
  makeElectronRouterClient,
} from '@/electron/rpc/router-core.js';
import { ElectronRpcs } from '@/lib/electron-rpc.js';

export interface ElectronRpcClient<Router extends ElectronRouter> {
  readonly close: () => Promise<void>;
  readonly router: ElectronRouterClient<Router>;
}

export function makeElectronRpcClient<Router extends ElectronRouter>(
  invoke: (
    request: RpcMessage.FromClientEncoded
  ) => Promise<RpcMessage.FromServerEncoded | undefined>
): ElectronRpcClient<Router> {
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

  const client = Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const protocolService = yield* protocol.pipe(
        Effect.provideService(Scope.Scope, scope)
      );
      const rpcClient = yield* RpcClient.make(ElectronRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocolService),
        Effect.provideService(Scope.Scope, scope)
      );
      return { rpcClient, scope };
    })
  );

  return {
    close: () =>
      client.then(({ scope }) =>
        Effect.runPromise(Scope.close(scope, Exit.void))
      ),
    router: makeElectronRouterClient((path, args) =>
      client.then(({ rpcClient }) =>
        Effect.runPromise(rpcClient.CallElectronProcedure({ path, args }))
      )
    ),
  };
}
