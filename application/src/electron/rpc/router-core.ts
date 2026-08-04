export interface ElectronProcedure<
  Path extends string = string,
  Args extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
  Result = unknown,
> {
  readonly path: Path;
  readonly handler: (...args: Args) => Result;
}

export type AnyElectronProcedure = ElectronProcedure<
  string,
  ReadonlyArray<any>,
  any
>;

export type ElectronRouter = ReadonlyArray<AnyElectronProcedure>;

export function procedure<
  const Path extends string,
  const Args extends ReadonlyArray<unknown>,
  Result,
>(
  path: Path,
  handler: (...args: Args) => Result
): ElectronProcedure<Path, Args, Result> {
  return { path, handler };
}

type IpcHandler<Args extends ReadonlyArray<unknown>, Result> = (
  event: undefined,
  ...args: Args
) => Result;

export function ipcProcedure<
  const Path extends string,
  const Args extends ReadonlyArray<unknown>,
  Result,
>(
  path: Path,
  handler: IpcHandler<Args, Result>
): ElectronProcedure<Path, Args, Result> {
  return procedure(path, (...args: Args) => handler(undefined, ...args));
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

type ProcedureClient<Procedure> =
  Procedure extends ElectronProcedure<string, infer Args, infer Result>
    ? (...args: Args) => Promise<Awaited<Result>>
    : never;

type ClientBranch<
  Path extends string,
  Procedure extends ElectronProcedure,
> = Path extends `${infer Head}.${infer Tail}`
  ? { readonly [Key in Head]: ClientBranch<Tail, Procedure> }
  : { readonly [Key in Path]: ProcedureClient<Procedure> };

type UnionToIntersection<Union> = (
  Union extends unknown
    ? (value: Union) => void
    : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type RouterClientBranch<Procedure> = Procedure extends AnyElectronProcedure
  ? ClientBranch<Procedure['path'], Procedure>
  : never;

export type ElectronRouterClient<Router extends ElectronRouter> =
  UnionToIntersection<RouterClientBranch<Router[number]>>;

export function makeElectronRouterClient<Router extends ElectronRouter>(
  call: (path: string, args: ReadonlyArray<unknown>) => Promise<unknown>
): ElectronRouterClient<Router> {
  const makeProxy = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) =>
        makeProxy(path ? `${path}.${String(property)}` : String(property)),
      apply: (_target, _thisArg, args: ReadonlyArray<unknown>) =>
        call(path, args),
    });

  return makeProxy('') as ElectronRouterClient<Router>;
}
