import { RpcClient, RpcClientError, type RpcMessage } from '@effect/rpc';
import { Effect, Exit, Scope } from 'effect';
import { ElectronRpcs, type OperatingSystem } from '@/lib/electron-rpc.js';

export interface ElectronRpcClient {
  readonly close: () => Promise<void>;
  readonly getOperatingSystem: () => Promise<OperatingSystem>;
  readonly invoke: <A>(
    channel: string,
    ...args: ReadonlyArray<unknown>
  ) => Promise<A>;
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
    getOperatingSystem: () =>
      client.then(({ rpcClient }) =>
        Effect.runPromise(rpcClient.GetOperatingSystem())
      ),
    invoke: <A>(channel: string, ...args: ReadonlyArray<unknown>) =>
      client.then(({ rpcClient }) =>
        Effect.runPromise(
          rpcClient
            .InvokeElectronHandler({ channel, args })
            .pipe(Effect.map((result) => result as A))
        )
      ),
  };
}
