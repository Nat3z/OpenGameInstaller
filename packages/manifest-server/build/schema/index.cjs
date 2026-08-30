Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
require("../src/server.cjs");
let effect = require("effect");
let node_crypto = require("node:crypto");
//#region schema/index.ts
const UPDATE_MANIFEST_VERSION = 1;
const Sha256 = effect.Schema.String.pipe(effect.Schema.pattern(/^[a-f0-9]{64}$/));
const RelativePath = effect.Schema.String.pipe(effect.Schema.maxLength(4096), effect.Schema.filter((value) => isSafeRelativePath(value), { message: () => "Expected a safe relative path" }));
const UpdateSourceSchema = effect.Schema.Struct({
	index: effect.Schema.NonNegativeInt,
	urlHash: Sha256,
	size: effect.Schema.NonNegativeInt,
	sha256: Sha256,
	etag: effect.Schema.optional(effect.Schema.String),
	lastModified: effect.Schema.optional(effect.Schema.String)
});
const UpdateEntrySchema = effect.Schema.Struct({
	path: RelativePath,
	size: effect.Schema.NonNegativeInt,
	sha256: Sha256,
	crc32: effect.Schema.NonNegativeInt,
	compression: effect.Schema.Literal("stored", "deflate"),
	sourceIndex: effect.Schema.NonNegativeInt,
	compressedSize: effect.Schema.NonNegativeInt,
	dataOffset: effect.Schema.NonNegativeInt,
	range: effect.Schema.Struct({
		start: effect.Schema.NonNegativeInt,
		end: effect.Schema.NonNegativeInt
	})
});
const UpdateManifestSchema = effect.Schema.Struct({
	schemaVersion: effect.Schema.Literal(1),
	encoding: effect.Schema.Literal("canonical-json"),
	sourceSetKey: Sha256,
	archive: effect.Schema.Struct({
		format: effect.Schema.Literal("zip"),
		multipart: effect.Schema.Boolean
	}),
	sources: effect.Schema.Array(UpdateSourceSchema).pipe(effect.Schema.maxItems(32)),
	entries: effect.Schema.Array(UpdateEntrySchema).pipe(effect.Schema.maxItems(25e4))
}).pipe(effect.Schema.filter(isStructurallyValidManifest, { message: () => "Update manifest ranges or indexes are invalid" }));
function sha256(value) {
	return (0, node_crypto.createHash)("sha256").update(value).digest("hex");
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
exports.UPDATE_MANIFEST_VERSION = UPDATE_MANIFEST_VERSION;
exports.UpdateEntrySchema = UpdateEntrySchema;
exports.UpdateManifestSchema = UpdateManifestSchema;
exports.UpdateSourceSchema = UpdateSourceSchema;
exports.canonicalJson = canonicalJson;
exports.isSafeRelativePath = isSafeRelativePath;
exports.sha256 = sha256;
exports.sourceSetIdentity = sourceSetIdentity;

//# sourceMappingURL=index.cjs.map