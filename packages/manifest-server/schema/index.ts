import { createHash } from 'node:crypto';
import { Schema } from 'effect';

export const UPDATE_MANIFEST_VERSION = 1 as const;

const Sha256 = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
const RelativePath = Schema.String.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => isSafeRelativePath(value), {
    message: () => 'Expected a safe relative path',
  })
);

export const UpdateSourceSchema = Schema.Struct({
  index: Schema.NonNegativeInt,
  urlHash: Sha256,
  size: Schema.NonNegativeInt,
  sha256: Sha256,
  etag: Schema.optional(Schema.String),
  lastModified: Schema.optional(Schema.String),
});

export const UpdateEntrySchema = Schema.Struct({
  path: RelativePath,
  size: Schema.NonNegativeInt,
  sha256: Sha256,
  crc32: Schema.NonNegativeInt,
  compression: Schema.Literal('stored', 'deflate'),
  sourceIndex: Schema.NonNegativeInt,
  compressedSize: Schema.NonNegativeInt,
  dataOffset: Schema.NonNegativeInt,
  range: Schema.Struct({
    start: Schema.NonNegativeInt,
    end: Schema.NonNegativeInt,
  }),
});

const UpdateManifestBaseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(UPDATE_MANIFEST_VERSION),
  encoding: Schema.Literal('canonical-json'),
  sourceSetKey: Sha256,
  archive: Schema.Struct({
    format: Schema.Literal('zip'),
    multipart: Schema.Boolean,
  }),
  sources: Schema.Array(UpdateSourceSchema).pipe(Schema.maxItems(32)),
  entries: Schema.Array(UpdateEntrySchema).pipe(Schema.maxItems(250_000)),
});

export const UpdateManifestSchema = UpdateManifestBaseSchema.pipe(
  Schema.filter(isStructurallyValidManifest, {
    message: () => 'Update manifest ranges or indexes are invalid',
  })
);

export type UpdateSource = typeof UpdateSourceSchema.Type;
export type UpdateEntry = typeof UpdateEntrySchema.Type;
export type UpdateManifest = typeof UpdateManifestSchema.Type;

export interface CanonicalSource {
  readonly url: string;
  readonly size: number;
  readonly etag?: string;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Content-addressed identity: the key folds in each source's HEAD-observable
 * size and etag, so a republished archive at the same URL yields a new key
 * instead of pinning the old manifest forever. canonicalJson drops undefined
 * etags deterministically.
 */
export function sourceSetIdentity(sources: readonly CanonicalSource[]): {
  readonly sourceSetKey: string;
  readonly urlHashes: readonly string[];
} {
  const urlHashes = sources.map((source) => sha256(source.url));
  return {
    sourceSetKey: sha256(
      canonicalJson(
        sources.map((source, index) => ({
          e: source.etag,
          s: source.size,
          u: urlHashes[index],
        }))
      )
    ),
    urlHashes,
  };
}

/** Re-derives the key from a manifest's own sources; must match sourceSetIdentity. */
export function sourceSetKeyFromManifestSources(
  sources: ReadonlyArray<{
    readonly urlHash: string;
    readonly size: number;
    readonly etag?: string;
  }>
): string {
  return sha256(
    canonicalJson(
      sources.map((source) => ({
        e: source.etag,
        s: source.size,
        u: source.urlHash,
      }))
    )
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  // Sort by code units, not locale: canonical output must be identical on
  // every machine regardless of ICU configuration.
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  const parts = value.split('/');
  if (parts[0] === '.ogi-update-ranges') return false;
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function isStructurallyValidManifest(
  manifest: typeof UpdateManifestBaseSchema.Type
): boolean {
  if (manifest.sources.length === 0) return false;
  if (
    manifest.sources.some((source, index) => source.index !== index) ||
    new Set(manifest.entries.map((entry) => entry.path)).size !==
      manifest.entries.length
  ) {
    return false;
  }
  return manifest.entries.every((entry) => {
    const source = manifest.sources[entry.sourceIndex];
    if (!source || entry.range.end < entry.range.start) return false;
    if (entry.compressedSize === 0) {
      return (
        entry.size === 0 &&
        entry.range.end < source.size &&
        entry.dataOffset >= entry.range.start &&
        entry.dataOffset <= source.size
      );
    }
    return (
      entry.range.end < source.size &&
      entry.dataOffset >= entry.range.start &&
      entry.range.end - entry.dataOffset + 1 === entry.compressedSize
    );
  });
}
