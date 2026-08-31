Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
const require_schema_index = require("../schema/index.cjs");
let node_zlib = require("node:zlib");
let effect = require("effect");
require("node:crypto");
effect.Data.TaggedError("StorageError");
var ManifestStorage = class extends effect.Context.Tag("ManifestStorage")() {};
//#endregion
//#region src/server.ts
/** Applies to both the raw request body and the inflated payload. */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const SOURCE_SET_KEY_PATTERN = /^[a-f0-9]{64}$/;
var HttpError = class extends effect.Data.TaggedError("HttpError") {};
function json(status, body) {
	return new Response(body, {
		status,
		headers: { "content-type": "application/json" }
	});
}
function problem(status, message) {
	return json(status, JSON.stringify({ error: message }));
}
/**
* Reads the body chunk-by-chunk so an oversized (or lying `content-length`)
* upload is rejected without ever being fully buffered.
*/
function readBoundedBody(request) {
	return effect.Effect.tryPromise({
		try: async () => {
			const body = request.body;
			if (!body) return new Uint8Array(0);
			const reader = body.getReader();
			const chunks = [];
			let total = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > MAX_MANIFEST_BYTES) {
					await reader.cancel();
					throw new HttpError({
						status: 413,
						message: "Manifest too large"
					});
				}
				chunks.push(value);
			}
			const result = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return result;
		},
		catch: (cause) => cause instanceof HttpError ? cause : new HttpError({
			status: 400,
			message: "Unable to read request body"
		})
	});
}
/**
* `maxOutputLength` bounds the inflated size inside zlib itself, so a zip-bomb
* body is aborted mid-inflation rather than after allocating the full output.
*/
function decodeBody(request, body) {
	const encoding = request.headers.get("content-encoding")?.toLowerCase();
	if (!encoding || encoding === "identity") return effect.Effect.succeed(new TextDecoder().decode(body));
	if (encoding !== "gzip") return effect.Effect.fail(new HttpError({
		status: 415,
		message: "Unsupported content encoding"
	}));
	return effect.Effect.try({
		try: () => (0, node_zlib.gunzipSync)(body, { maxOutputLength: MAX_MANIFEST_BYTES }).toString("utf8"),
		catch: (cause) => cause?.code === "ERR_BUFFER_TOO_LARGE" ? new HttpError({
			status: 413,
			message: "Manifest too large"
		}) : new HttpError({
			status: 400,
			message: "Malformed gzip body"
		})
	});
}
function parseManifest(text) {
	return effect.Effect.try({
		try: () => JSON.parse(text),
		catch: () => new HttpError({
			status: 400,
			message: "Malformed JSON body"
		})
	}).pipe(effect.Effect.flatMap((value) => effect.Schema.decodeUnknown(require_schema_index.UpdateManifestSchema, { onExcessProperty: "error" })(value).pipe(effect.Effect.mapError(() => new HttpError({
		status: 422,
		message: "Invalid update manifest"
	})))));
}
function handleGet(sourceSetKey) {
	return effect.Effect.gen(function* () {
		if (!SOURCE_SET_KEY_PATTERN.test(sourceSetKey)) return yield* new HttpError({
			status: 400,
			message: "Invalid source set key"
		});
		const stored = yield* (yield* ManifestStorage).get(sourceSetKey);
		if (!stored) return yield* new HttpError({
			status: 404,
			message: "Manifest not found"
		});
		return json(200, `{"manifest":${new TextDecoder().decode(stored)}}`);
	});
}
function handlePost(request) {
	return effect.Effect.gen(function* () {
		const manifest = yield* parseManifest(yield* decodeBody(request, yield* readBoundedBody(request)));
		const key = manifest.sourceSetKey;
		if (key !== require_schema_index.sourceSetKeyFromManifestSources(manifest.sources)) return yield* new HttpError({
			status: 422,
			message: "Source set key does not match the manifest sources"
		});
		const canonical = new TextEncoder().encode(require_schema_index.canonicalJson(manifest));
		const storage = yield* ManifestStorage;
		if (yield* storage.putIfAbsent(key, canonical)) return json(201, JSON.stringify({
			status: "stored",
			sourceSetKey: key
		}));
		const existing = yield* storage.get(key);
		return existing !== void 0 && existing.byteLength === canonical.byteLength && existing.every((byte, index) => byte === canonical[index]) ? json(200, JSON.stringify({
			status: "exists",
			sourceSetKey: key
		})) : problem(409, "A different manifest is already stored for this key");
	});
}
function handleRequest(request) {
	const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
	return (() => {
		if (request.method === "GET" && path === "/healthz") return effect.Effect.succeed(json(200, JSON.stringify({ status: "ok" })));
		if (request.method === "POST" && path === "/v1/manifests") return handlePost(request);
		const rawKey = /^\/v1\/manifests\/([^/]+)$/.exec(path)?.[1];
		if (request.method === "GET" && rawKey) return effect.Effect.try({
			try: () => decodeURIComponent(rawKey),
			catch: () => new HttpError({
				status: 400,
				message: "Invalid source set key"
			})
		}).pipe(effect.Effect.flatMap(handleGet));
		return effect.Effect.fail(new HttpError({
			status: 404,
			message: "Not found"
		}));
	})().pipe(effect.Effect.catchTag("HttpError", (error) => effect.Effect.succeed(problem(error.status, error.message))), effect.Effect.catchTag("StorageError", (error) => effect.Effect.logError(`[manifest] ${error.message}`, error.cause).pipe(effect.Effect.as(problem(500, "Storage unavailable")))), effect.Effect.catchAllDefect((defect) => effect.Effect.logError("[manifest] Unhandled request defect", defect).pipe(effect.Effect.as(problem(500, "Internal error")))));
}
function createServer(options) {
	return effect.Effect.gen(function* () {
		const runtime = yield* effect.Effect.runtime();
		const runPromise = effect.Runtime.runPromise(runtime);
		return Bun.serve({
			port: options.port,
			fetch: (request) => runPromise(handleRequest(request))
		});
	});
}
//#endregion
exports.__toESM = __toESM;
exports.createServer = createServer;
exports.handleRequest = handleRequest;

//# sourceMappingURL=server.cjs.map