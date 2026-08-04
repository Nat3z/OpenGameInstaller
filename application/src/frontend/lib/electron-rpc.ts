import type { Rpc, RpcGroup } from '@effect/rpc';
import { RpcClient, RpcClientError, type RpcMessage } from '@effect/rpc';
import { Effect, Exit, Scope } from 'effect';
import { ElectronRpcs } from '@/lib/electron-rpc.js';

type ProcedureApi<Procedure extends Rpc.Any> = Procedure extends Rpc.Any
  ? Procedure['_tag'] extends `${infer Head}.${infer Tail}`
    ? { readonly [Key in Head]: ProcedureApiAt<Tail, Procedure> }
    : ProcedureApiAt<Procedure['_tag'], Procedure>
  : never;

type ProcedureApiAt<
  Path extends string,
  Procedure extends Rpc.Any,
> = Path extends `${infer Head}.${infer Tail}`
  ? { readonly [Key in Head]: ProcedureApiAt<Tail, Procedure> }
  : {
      readonly [Key in Path]: Procedure extends {
        readonly _Client: infer Client;
      }
        ? Client
        : (
            ...args: Rpc.Payload<Procedure>
          ) => Effect.Effect<
            Rpc.Success<Procedure>,
            Rpc.Error<Procedure> | RpcClientError.RpcClientError
          >;
    };

type UnionToIntersection<Union> = (
  Union extends unknown
    ? (value: Union) => void
    : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type ElectronRpcApi = UnionToIntersection<
  ProcedureApi<RpcGroup.Rpcs<typeof ElectronRpcs>>
>;

interface ElectronRpcClient {
  readonly api: ElectronRpcApi;
  readonly close: Effect.Effect<void>;
}

function makeElectronRpcClient(
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

  const api: Record<string, unknown> = {};
  for (const tag of ElectronRpcs.requests.keys()) {
    const segments = tag.split('.');
    const method = segments.pop() as string;
    let branch = api;
    for (const segment of segments) {
      const child = branch[segment];
      if (typeof child === 'object' && child !== null) {
        branch = child as Record<string, unknown>;
      } else {
        const next: Record<string, unknown> = {};
        branch[segment] = next;
        branch = next;
      }
    }
    branch[method] = (...args: ReadonlyArray<unknown>) =>
      Effect.promise(() => client).pipe(
        Effect.flatMap(({ rpcClient }) => {
          const [prefix, ...rest] = tag.split('.');
          const rpcMethod =
            rest.length === 0
              ? rpcClient[tag as keyof typeof rpcClient]
              : (
                  rpcClient[prefix as keyof typeof rpcClient] as Record<
                    string,
                    unknown
                  >
                )[rest.join('.')];
          return (
            rpcMethod as (
              payload: ReadonlyArray<unknown>
            ) => Effect.Effect<unknown, unknown>
          )(args);
        })
      );
  }

  return {
    api: api as ElectronRpcApi,
    close: Effect.promise(() => client).pipe(
      Effect.flatMap(({ scope }) => Scope.close(scope, Exit.void))
    ),
  };
}

const client = makeElectronRpcClient((message) =>
  window.electronRpcTransport.invoke(message)
);

export const electronRpc = client.api;

window.addEventListener('unload', () => {
  Effect.runFork(client.close);
});
