import type { Rpc } from '@effect/rpc';

export interface ElectronProcedure<Procedure extends Rpc.Any = Rpc.Any> {
  readonly rpc: Procedure;
  readonly handler: (...args: Rpc.Payload<Procedure>) => unknown;
}

export interface AnyElectronProcedure {
  readonly rpc: Rpc.Any;
  readonly handler: (...args: any[]) => unknown;
}

export type ElectronRouter = ReadonlyArray<AnyElectronProcedure>;

export function procedure<const Procedure extends Rpc.Any>(
  rpc: Procedure,
  handler: (...args: Rpc.Payload<Procedure>) => unknown
): ElectronProcedure<Procedure> {
  return { rpc, handler };
}

type IpcHandler<Procedure extends Rpc.Any> = (
  event: undefined,
  ...args: Rpc.Payload<Procedure>
) => unknown;

export function ipcProcedure<const Procedure extends Rpc.Any>(
  rpc: Procedure,
  handler: IpcHandler<Procedure>
): ElectronProcedure<Procedure> {
  return procedure(rpc, (...args) => handler(undefined, ...args));
}

export function router<const Procedures extends ElectronRouter>(
  ...procedures: Procedures
): Procedures {
  return procedures;
}

export function mergeRouters<
  const Routers extends ReadonlyArray<ElectronRouter>,
>(...routers: Routers): MergeRouters<Routers> {
  return routers.flat() as unknown as MergeRouters<Routers>;
}

type MergeRouters<
  Routers extends ReadonlyArray<ElectronRouter>,
  Result extends ElectronRouter = readonly [],
> = Routers extends readonly [
  infer Head extends ElectronRouter,
  ...infer Tail extends ReadonlyArray<ElectronRouter>,
]
  ? MergeRouters<Tail, readonly [...Result, ...Head]>
  : Result;
