import { gunzipSync } from 'node:zlib';
import { Data, Effect, Runtime, Schema } from 'effect';
import {
  canonicalJson,
  sha256,
  type UpdateManifest,
  UpdateManifestSchema,
} from '../schema/index.js';
import { ManifestStorage, type StorageError } from './storage.js';

/** Applies to both the raw request body and the inflated payload. */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const SOURCE_SET_KEY_PATTERN = /^[a-f0-9]{64}$/;

class HttpError extends Data.TaggedError('HttpError')<{
  readonly status: number;
  readonly message: string;
}> {}

function json(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(status: number, message: string): Response {
  return json(status, JSON.stringify({ error: message }));
}

/**
 * Reads the body chunk-by-chunk so an oversized (or lying `content-length`)
 * upload is rejected without ever being fully buffered.
 */
function readBoundedBody(
  request: Request
): Effect.Effect<Uint8Array, HttpError> {
  return Effect.tryPromise({
    try: async (): Promise<Uint8Array> => {
      const body = request.body;
      if (!body) return new Uint8Array(0);
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MANIFEST_BYTES) {
          await reader.cancel();
          throw new HttpError({ status: 413, message: 'Manifest too large' });
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
    catch: (cause) =>
      cause instanceof HttpError
        ? cause
        : new HttpError({
            status: 400,
            message: 'Unable to read request body',
          }),
  });
}

/**
 * `maxOutputLength` bounds the inflated size inside zlib itself, so a zip-bomb
 * body is aborted mid-inflation rather than after allocating the full output.
 */
function decodeBody(
  request: Request,
  body: Uint8Array
): Effect.Effect<string, HttpError> {
  const encoding = request.headers.get('content-encoding')?.toLowerCase();
  if (!encoding || encoding === 'identity') {
    return Effect.succeed(new TextDecoder().decode(body));
  }
  if (encoding !== 'gzip') {
    return Effect.fail(
      new HttpError({ status: 415, message: 'Unsupported content encoding' })
    );
  }
  return Effect.try({
    try: () =>
      gunzipSync(body, { maxOutputLength: MAX_MANIFEST_BYTES }).toString(
        'utf8'
      ),
    catch: (cause) =>
      (cause as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE'
        ? new HttpError({ status: 413, message: 'Manifest too large' })
        : new HttpError({ status: 400, message: 'Malformed gzip body' }),
  });
}

function parseManifest(text: string): Effect.Effect<UpdateManifest, HttpError> {
  return Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => new HttpError({ status: 400, message: 'Malformed JSON body' }),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknown(UpdateManifestSchema, {
        onExcessProperty: 'error',
      })(value).pipe(
        Effect.mapError(
          () =>
            new HttpError({ status: 422, message: 'Invalid update manifest' })
        )
      )
    )
  );
}

function handleGet(
  sourceSetKey: string
): Effect.Effect<Response, HttpError | StorageError, ManifestStorage> {
  return Effect.gen(function* () {
    if (!SOURCE_SET_KEY_PATTERN.test(sourceSetKey)) {
      return yield* new HttpError({
        status: 400,
        message: 'Invalid source set key',
      });
    }
    const storage = yield* ManifestStorage;
    const stored = yield* storage.get(sourceSetKey);
    if (!stored) {
      return yield* new HttpError({
        status: 404,
        message: 'Manifest not found',
      });
    }
    // Stored bytes are already canonical JSON, so they embed verbatim.
    return json(200, `{"manifest":${new TextDecoder().decode(stored)}}`);
  });
}

function handlePost(
  request: Request
): Effect.Effect<Response, HttpError | StorageError, ManifestStorage> {
  return Effect.gen(function* () {
    const body = yield* readBoundedBody(request);
    const text = yield* decodeBody(request, body);
    const manifest = yield* parseManifest(text);

    // The key must be derived from the manifest's own source hashes, so a
    // submitter cannot reserve an arbitrary key with unrelated sources.
    const key = manifest.sourceSetKey;
    const derivedKey = sha256(
      canonicalJson(manifest.sources.map((source) => source.urlHash))
    );
    if (key !== derivedKey) {
      return yield* new HttpError({
        status: 422,
        message: 'Source set key does not match the manifest sources',
      });
    }
    const canonical = new TextEncoder().encode(canonicalJson(manifest));
    const storage = yield* ManifestStorage;

    // First submit wins: an existing key is never overwritten. putIfAbsent
    // resolves the race between concurrent first submits.
    const stored = yield* storage.putIfAbsent(key, canonical);
    if (stored) {
      return json(201, JSON.stringify({ status: 'stored', sourceSetKey: key }));
    }
    const existing = yield* storage.get(key);
    const identical =
      existing !== undefined &&
      existing.byteLength === canonical.byteLength &&
      existing.every((byte, index) => byte === canonical[index]);
    return identical
      ? json(200, JSON.stringify({ status: 'exists', sourceSetKey: key }))
      : problem(409, 'A different manifest is already stored for this key');
  });
}

export function handleRequest(
  request: Request
): Effect.Effect<Response, never, ManifestStorage> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const route = ((): Effect.Effect<
    Response,
    HttpError | StorageError,
    ManifestStorage
  > => {
    if (request.method === 'GET' && path === '/healthz') {
      return Effect.succeed(json(200, JSON.stringify({ status: 'ok' })));
    }
    if (request.method === 'POST' && path === '/v1/manifests') {
      return handlePost(request);
    }
    const rawKey = /^\/v1\/manifests\/([^/]+)$/.exec(path)?.[1];
    if (request.method === 'GET' && rawKey) {
      return Effect.try({
        try: () => decodeURIComponent(rawKey),
        catch: () =>
          new HttpError({ status: 400, message: 'Invalid source set key' }),
      }).pipe(Effect.flatMap(handleGet));
    }
    return Effect.fail(new HttpError({ status: 404, message: 'Not found' }));
  })();

  return route.pipe(
    Effect.catchTag('HttpError', (error) =>
      Effect.succeed(problem(error.status, error.message))
    ),
    Effect.catchTag('StorageError', (error) =>
      Effect.logError(`[manifest] ${error.message}`, error.cause).pipe(
        Effect.as(problem(500, 'Storage unavailable'))
      )
    ),
    Effect.catchAllDefect((defect) =>
      Effect.logError('[manifest] Unhandled request defect', defect).pipe(
        Effect.as(problem(500, 'Internal error'))
      )
    )
  );
}

export function createServer(options: {
  readonly port: number;
}): Effect.Effect<Bun.Server<undefined>, never, ManifestStorage> {
  return Effect.gen(function* () {
    // Captured once: every request reuses this runtime instead of rebuilding
    // the storage layer per fetch.
    const runtime = yield* Effect.runtime<ManifestStorage>();
    const runPromise = Runtime.runPromise(runtime);
    return Bun.serve({
      port: options.port,
      fetch: (request) => runPromise(handleRequest(request)),
    });
  });
}
