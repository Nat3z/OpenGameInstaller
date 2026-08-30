import { Schema } from "effect";

//#region schema/index.d.ts
declare const UPDATE_MANIFEST_VERSION: 1;
declare const UpdateSourceSchema: Schema.Struct<{
  index: Schema.refine<number, typeof Schema.NonNegative>;
  urlHash: Schema.filter<typeof Schema.String>;
  size: Schema.refine<number, typeof Schema.NonNegative>;
  sha256: Schema.filter<typeof Schema.String>;
  etag: Schema.optional<typeof Schema.String>;
  lastModified: Schema.optional<typeof Schema.String>;
}>;
declare const UpdateEntrySchema: Schema.Struct<{
  path: Schema.filter<Schema.filter<typeof Schema.String>>;
  size: Schema.refine<number, typeof Schema.NonNegative>;
  sha256: Schema.filter<typeof Schema.String>;
  crc32: Schema.refine<number, typeof Schema.NonNegative>;
  compression: Schema.Literal<["stored", "deflate"]>;
  sourceIndex: Schema.refine<number, typeof Schema.NonNegative>;
  compressedSize: Schema.refine<number, typeof Schema.NonNegative>;
  dataOffset: Schema.refine<number, typeof Schema.NonNegative>;
  range: Schema.Struct<{
    start: Schema.refine<number, typeof Schema.NonNegative>;
    end: Schema.refine<number, typeof Schema.NonNegative>;
  }>;
}>;
declare const UpdateManifestSchema: Schema.filter<Schema.Struct<{
  schemaVersion: Schema.Literal<[1]>;
  encoding: Schema.Literal<["canonical-json"]>;
  sourceSetKey: Schema.filter<typeof Schema.String>;
  archive: Schema.Struct<{
    format: Schema.Literal<["zip"]>;
    multipart: typeof Schema.Boolean;
  }>;
  sources: Schema.filter<Schema.Array$<Schema.Struct<{
    index: Schema.refine<number, typeof Schema.NonNegative>;
    urlHash: Schema.filter<typeof Schema.String>;
    size: Schema.refine<number, typeof Schema.NonNegative>;
    sha256: Schema.filter<typeof Schema.String>;
    etag: Schema.optional<typeof Schema.String>;
    lastModified: Schema.optional<typeof Schema.String>;
  }>>>;
  entries: Schema.filter<Schema.Array$<Schema.Struct<{
    path: Schema.filter<Schema.filter<typeof Schema.String>>;
    size: Schema.refine<number, typeof Schema.NonNegative>;
    sha256: Schema.filter<typeof Schema.String>;
    crc32: Schema.refine<number, typeof Schema.NonNegative>;
    compression: Schema.Literal<["stored", "deflate"]>;
    sourceIndex: Schema.refine<number, typeof Schema.NonNegative>;
    compressedSize: Schema.refine<number, typeof Schema.NonNegative>;
    dataOffset: Schema.refine<number, typeof Schema.NonNegative>;
    range: Schema.Struct<{
      start: Schema.refine<number, typeof Schema.NonNegative>;
      end: Schema.refine<number, typeof Schema.NonNegative>;
    }>;
  }>>>;
}>>;
type UpdateSource = typeof UpdateSourceSchema.Type;
type UpdateEntry = typeof UpdateEntrySchema.Type;
type UpdateManifest = typeof UpdateManifestSchema.Type;
interface CanonicalSource {
  readonly url: string;
}
declare function sha256(value: string | Uint8Array): string;
declare function sourceSetIdentity(sources: readonly CanonicalSource[]): {
  readonly sourceSetKey: string;
  readonly urlHashes: readonly string[];
};
declare function canonicalJson(value: unknown): string;
declare function isSafeRelativePath(value: string): boolean;
//#endregion
export { CanonicalSource, UPDATE_MANIFEST_VERSION, UpdateEntry, UpdateEntrySchema, UpdateManifest, UpdateManifestSchema, UpdateSource, UpdateSourceSchema, canonicalJson, isSafeRelativePath, sha256, sourceSetIdentity };
//# sourceMappingURL=index.d.mts.map