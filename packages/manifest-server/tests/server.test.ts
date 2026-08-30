import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Effect } from 'effect';
import {
  canonicalJson,
  sourceSetIdentity,
  UPDATE_MANIFEST_VERSION,
  type UpdateManifest,
} from '../schema/index.js';
import { createServer } from '../src/server.js';
import { LocalStorageLive } from '../src/storage.js';

const hash = (value: string): string => Bun.SHA256.hash(value, 'hex');
const identity = sourceSetIdentity([{ url: 'https://example.test/game.zip' }]);

// Each test seeds its own source-set identity so ordering never matters.
function makeManifest(overrides: {
  readonly entrySize: number;
  readonly identity?: ReturnType<typeof sourceSetIdentity>;
}): UpdateManifest {
  const id = overrides.identity ?? identity;
  return {
    schemaVersion: UPDATE_MANIFEST_VERSION,
    encoding: 'canonical-json',
    sourceSetKey: id.sourceSetKey,
    archive: { format: 'zip', multipart: false },
    sources: [
      {
        index: 0,
        urlHash: id.urlHashes[0]!,
        size: 1_000,
        sha256: hash('archive'),
      },
    ],
    entries: [
      {
        path: 'game/data.bin',
        size: overrides.entrySize,
        sha256: hash('entry'),
        crc32: 12_345,
        compression: 'deflate',
        sourceIndex: 0,
        compressedSize: 100,
        dataOffset: 30,
        range: { start: 0, end: 129 },
      },
    ],
  };
}

const directory = mkdtempSync(join(tmpdir(), 'manifest-server-'));
let baseUrl: string;
let server: Bun.Server<undefined>;

const post = (body: Bun.BodyInit, gzip: boolean): Promise<Response> =>
  fetch(`${baseUrl}/v1/manifests`, {
    method: 'POST',
    headers: gzip
      ? { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }
      : { 'Content-Type': 'application/json' },
    body,
  });

beforeAll(async () => {
  server = await Effect.runPromise(
    createServer({ port: 0 }).pipe(Effect.provide(LocalStorageLive(directory)))
  );
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

describe('manifest server', () => {
  test('stores a gzipped manifest and serves it back', async () => {
    const manifest = makeManifest({ entrySize: 256 });
    const stored = await post(gzipSync(canonicalJson(manifest)), true);
    expect(stored.status).toBe(201);

    const fetched = await fetch(
      `${baseUrl}/v1/manifests/${identity.sourceSetKey}`,
      { headers: { Accept: 'application/json' } }
    );
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toContain('application/json');
    expect(await fetched.json()).toEqual({ manifest });
  });

  test('accepts an identical re-submission idempotently', async () => {
    const id = sourceSetIdentity([{ url: 'https://example.test/idem.zip' }]);
    const manifest = makeManifest({ entrySize: 256, identity: id });
    const body = gzipSync(canonicalJson(manifest));
    expect((await post(body, true)).status).toBe(201);
    expect((await post(body, true)).status).toBe(200);
  });

  test('rejects a conflicting manifest for the same key', async () => {
    const id = sourceSetIdentity([
      { url: 'https://example.test/conflict.zip' },
    ]);
    const baseline = makeManifest({ entrySize: 256, identity: id });
    expect((await post(gzipSync(canonicalJson(baseline)), true)).status).toBe(
      201
    );
    const conflicting = makeManifest({ entrySize: 512, identity: id });
    const response = await post(gzipSync(canonicalJson(conflicting)), true);
    expect(response.status).toBe(409);
  });

  test('rejects a source set key that does not match the sources', async () => {
    const other = sourceSetIdentity([
      { url: 'https://example.test/other.zip' },
    ]);
    const manifest = {
      ...makeManifest({ entrySize: 256 }),
      sourceSetKey: other.sourceSetKey,
    };
    const response = await post(gzipSync(canonicalJson(manifest)), true);
    expect(response.status).toBe(422);
  });

  test('rejects a structurally invalid manifest', async () => {
    const manifest = makeManifest({ entrySize: 256 });
    const broken = { ...manifest, sources: [] };
    const response = await post(JSON.stringify(broken), false);
    expect(response.status).toBe(422);
  });

  test('rejects a zero-length entry whose range escapes its source', async () => {
    const id = sourceSetIdentity([{ url: 'https://example.test/empty.zip' }]);
    const manifest = makeManifest({ entrySize: 0, identity: id });
    const invalid = {
      ...manifest,
      entries: [
        {
          ...manifest.entries[0]!,
          size: 0,
          compressedSize: 0,
          dataOffset: 0,
          range: { start: 0, end: 1_000 },
        },
      ],
    };
    const response = await post(JSON.stringify(invalid), false);
    expect(response.status).toBe(422);
  });

  test('rejects a malformed source set key', async () => {
    const response = await fetch(`${baseUrl}/v1/manifests/not-a-key`);
    expect(response.status).toBe(400);
  });

  test('reports health', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
