import { Schema } from "effect";
import { createHash } from "node:crypto";
//#region schema/index.ts
const UPDATE_MANIFEST_VERSION = 1;
const Sha256 = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
const RelativePath = Schema.String.pipe(Schema.maxLength(4096), Schema.filter((value) => isSafeRelativePath(value), { message: () => "Expected a safe relative path" }));
const UpdateSourceSchema = Schema.Struct({
	index: Schema.NonNegativeInt,
	urlHash: Sha256,
	size: Schema.NonNegativeInt,
	sha256: Sha256,
	etag: Schema.optional(Schema.String),
	lastModified: Schema.optional(Schema.String)
});
const UpdateEntrySchema = Schema.Struct({
	path: RelativePath,
	size: Schema.NonNegativeInt,
	sha256: Sha256,
	crc32: Schema.NonNegativeInt,
	compression: Schema.Literal("stored", "deflate"),
	sourceIndex: Schema.NonNegativeInt,
	compressedSize: Schema.NonNegativeInt,
	dataOffset: Schema.NonNegativeInt,
	range: Schema.Struct({
		start: Schema.NonNegativeInt,
		end: Schema.NonNegativeInt
	})
});
const UpdateManifestSchema = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	encoding: Schema.Literal("canonical-json"),
	sourceSetKey: Sha256,
	archive: Schema.Struct({
		format: Schema.Literal("zip"),
		multipart: Schema.Boolean
	}),
	sources: Schema.Array(UpdateSourceSchema).pipe(Schema.maxItems(32)),
	entries: Schema.Array(UpdateEntrySchema).pipe(Schema.maxItems(25e4))
}).pipe(Schema.filter(isStructurallyValidManifest, { message: () => "Update manifest ranges or indexes are invalid" }));
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
function sourceSetIdentity(sources) {
	const urlHashes = sources.map((source) => sha256(source.url));
	return {
		sourceSetKey: sha256(canonicalJson(urlHashes)),
		urlHashes
	};
}
function canonicalJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
function isSafeRelativePath(value) {
	if (!value || value.includes("\0") || value.includes("\\")) return false;
	if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
	const parts = value.split("/");
	if (parts[0] === ".ogi-update-ranges") return false;
	return parts.every((part) => part !== "" && part !== "." && part !== "..");
}
function isStructurallyValidManifest(manifest) {
	if (manifest.sources.length === 0) return false;
	if (manifest.sources.some((source, index) => source.index !== index) || new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length) return false;
	return manifest.entries.every((entry) => {
		const source = manifest.sources[entry.sourceIndex];
		if (!source || entry.range.end < entry.range.start) return false;
		if (entry.compressedSize === 0) return entry.size === 0 && entry.range.end < source.size && entry.dataOffset >= entry.range.start && entry.dataOffset <= source.size;
		return entry.range.end < source.size && entry.dataOffset >= entry.range.start && entry.range.end - entry.dataOffset + 1 === entry.compressedSize;
	});
}
//#endregion
export { UPDATE_MANIFEST_VERSION, UpdateEntrySchema, UpdateManifestSchema, UpdateSourceSchema, canonicalJson, isSafeRelativePath, sha256, sourceSetIdentity };

//# sourceMappingURL=index.mjs.map