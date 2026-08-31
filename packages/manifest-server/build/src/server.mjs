import { UpdateManifestSchema, canonicalJson, sourceSetKeyFromManifestSources } from "../schema/index.mjs";
import { gunzipSync } from "node:zlib";
import { Context, Data, Effect, Runtime, Schema } from "effect";
Data.TaggedError("StorageError");
var ManifestStorage = class extends Context.Tag("ManifestStorage")() {};
//#endregion
//#region src/server.ts
/** Applies to both the raw request body and the inflated payload. */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const SOURCE_SET_KEY_PATTERN = /^[a-f0-9]{64}$/;
var HttpError = class extends Data.TaggedError("HttpError") {};
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
	return Effect.tryPromise({
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
	if (!encoding || encoding === "identity") return Effect.succeed(new TextDecoder().decode(body));
	if (encoding !== "gzip") return Effect.fail(new HttpError({
		status: 415,
		message: "Unsupported content encoding"
	}));
	return Effect.try({
		try: () => gunzipSync(body, { maxOutputLength: MAX_MANIFEST_BYTES }).toString("utf8"),
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
	return Effect.try({
		try: () => JSON.parse(text),
		catch: () => new HttpError({
			status: 400,
			message: "Malformed JSON body"
		})
	}).pipe(Effect.flatMap((value) => Schema.decodeUnknown(UpdateManifestSchema, { onExcessProperty: "error" })(value).pipe(Effect.mapError(() => new HttpError({
		status: 422,
		message: "Invalid update manifest"
	})))));
}
function handleGet(sourceSetKey) {
	return Effect.gen(function* () {
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
	return Effect.gen(function* () {
		const manifest = yield* parseManifest(yield* decodeBody(request, yield* readBoundedBody(request)));
		const key = manifest.sourceSetKey;
		if (key !== sourceSetKeyFromManifestSources(manifest.sources)) return yield* new HttpError({
			status: 422,
			message: "Source set key does not match the manifest sources"
		});
		const canonical = new TextEncoder().encode(canonicalJson(manifest));
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
		if (request.method === "GET" && path === "/healthz") return Effect.succeed(json(200, JSON.stringify({ status: "ok" })));
		if (request.method === "POST" && path === "/v1/manifests") return handlePost(request);
		const rawKey = /^\/v1\/manifests\/([^/]+)$/.exec(path)?.[1];
		if (request.method === "GET" && rawKey) return Effect.try({
			try: () => decodeURIComponent(rawKey),
			catch: () => new HttpError({
				status: 400,
				message: "Invalid source set key"
			})
		}).pipe(Effect.flatMap(handleGet));
		return Effect.fail(new HttpError({
			status: 404,
			message: "Not found"
		}));
	})().pipe(Effect.catchTag("HttpError", (error) => Effect.succeed(problem(error.status, error.message))), Effect.catchTag("StorageError", (error) => Effect.logError(`[manifest] ${error.message}`, error.cause).pipe(Effect.as(problem(500, "Storage unavailable")))), Effect.catchAllDefect((defect) => Effect.logError("[manifest] Unhandled request defect", defect).pipe(Effect.as(problem(500, "Internal error")))));
}
function createServer(options) {
	return Effect.gen(function* () {
		const runtime = yield* Effect.runtime();
		const runPromise = Runtime.runPromise(runtime);
		return Bun.serve({
			port: options.port,
			fetch: (request) => runPromise(handleRequest(request))
		});
	});
}
//#endregion
export { createServer, handleRequest };

//# sourceMappingURL=server.mjs.map