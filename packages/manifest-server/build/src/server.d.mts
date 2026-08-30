import { Context, Effect } from "effect";
import * as _$effect_Types0 from "effect/Types";
import * as _$effect_Cause0 from "effect/Cause";

//#region src/storage.d.ts
declare const StorageError_base: new <A extends Record<string, any> = {}>(args: _$effect_Types0.VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }>) => _$effect_Cause0.YieldableError & {
  readonly _tag: "StorageError";
} & Readonly<A>;
declare class StorageError extends StorageError_base<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
declare const ManifestStorage_base: Context.TagClass<ManifestStorage, "ManifestStorage", {
  readonly get: (key: string) => Effect.Effect<Uint8Array | undefined, StorageError>; /** Stores the manifest unless the key already exists; false means it lost to an earlier write. */
  readonly putIfAbsent: (key: string, data: Uint8Array) => Effect.Effect<boolean, StorageError>;
}>;
declare class ManifestStorage extends ManifestStorage_base {}
//#endregion
//#region src/server.d.ts
declare function handleRequest(request: Request): Effect.Effect<Response, never, ManifestStorage>;
declare function createServer(options: {
  readonly port: number;
}): Effect.Effect<Bun.Server<undefined>, never, ManifestStorage>;
//#endregion
export { createServer, handleRequest };
//# sourceMappingURL=server.d.mts.map