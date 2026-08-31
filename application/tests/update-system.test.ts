import { describe, expect, test } from 'bun:test';
import { Effect, Schema } from 'effect';
import {
  canonicalJson,
  isSafeRelativePath,
  type OwnershipManifest,
  sha256,
  sourceSetIdentity,
  type UpdateManifest,
  UpdateManifestSchema,
} from '../src/electron/update-system/model';
import { captureOwnershipFiles } from '../src/electron/update-system/ownership';
import { planUpdate } from '../src/electron/update-system/planner';

const hash = 'a'.repeat(64);
const changedHash = 'b'.repeat(64);
const generatedHash = 'c'.repeat(64);

function manifest(): UpdateManifest {
  return {
    schemaVersion: 1,
    encoding: 'canonical-json',
    sourceSetKey: hash,
    archive: { format: 'zip', multipart: false },
    sources: [{ index: 0, urlHash: hash, size: 800, sha256: changedHash }],
    entries: [
      {
        path: 'game/unchanged.bin',
        size: 600,
        sha256: hash,
        crc32: 1,
        compression: 'stored',
        sourceIndex: 0,
        compressedSize: 600,
        dataOffset: 0,
        range: { start: 0, end: 599 },
      },
      {
        path: 'game/changed.bin',
        size: 100,
        sha256: changedHash,
        crc32: 2,
        compression: 'deflate',
        sourceIndex: 0,
        compressedSize: 100,
        dataOffset: 700,
        range: { start: 700, end: 799 },
      },
    ],
  };
}

function ownership(): OwnershipManifest {
  return {
    schemaVersion: 1,
    appID: 10,
    root: '/games/example',
    sourceSetKey: changedHash,
    files: [
      {
        sourcePath: 'game/unchanged.bin',
        installedPath: 'unchanged.bin',
        size: 600,
        sha256: hash,
      },
    ],
  };
}

describe('update model', () => {
  test('canonicalizes objects while preserving source order', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 1 } })).toBe(
      '{"a":{"b":1,"d":2},"z":1}'
    );
    expect(
      sourceSetIdentity([
        { url: 'https://a', size: 1 },
        { url: 'https://b', size: 2 },
      ]).sourceSetKey
    ).not.toBe(
      sourceSetIdentity([
        { url: 'https://b', size: 2 },
        { url: 'https://a', size: 1 },
      ]).sourceSetKey
    );
  });

  test('binds the source-set key to content identity, not just the URL', () => {
    const base = sourceSetIdentity([{ url: 'https://a', size: 800 }]);
    expect(
      sourceSetIdentity([{ url: 'https://a', size: 801 }]).sourceSetKey
    ).not.toBe(base.sourceSetKey);
    expect(
      sourceSetIdentity([{ url: 'https://a', size: 800, etag: '"v2"' }])
        .sourceSetKey
    ).not.toBe(base.sourceSetKey);
    // The community server re-derives the key from a stored manifest's own
    // sources array, so that derivation must stay byte-identical.
    const source = { index: 0, urlHash: sha256('https://a'), size: 800 };
    expect(sha256(canonicalJson([{ s: source.size, u: source.urlHash }]))).toBe(
      base.sourceSetKey
    );
  });

  test('rejects archive traversal paths', () => {
    expect(isSafeRelativePath('game/data.bin')).toBe(true);
    expect(isSafeRelativePath('../save.dat')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('C:/Windows/file')).toBe(false);
    expect(isSafeRelativePath('.ogi-update-ranges/0-10')).toBe(false);
  });

  test('requires worthwhile transfer savings', () => {
    const plan = planUpdate(manifest(), ownership());
    expect(plan?.reuse).toHaveLength(1);
    expect(plan?.download).toHaveLength(1);
    expect(plan?.savingsRatio).toBe(0.875);
    expect(
      planUpdate(manifest(), { ...ownership(), files: [] })
    ).toBeUndefined();
  });

  test('rejects duplicate entry paths', async () => {
    const valid = manifest();
    const invalid = {
      ...valid,
      entries: [
        valid.entries[0],
        { ...valid.entries[1], path: valid.entries[0].path },
      ],
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(UpdateManifestSchema)(invalid).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
  });

  test('rejects out-of-source entry ranges', async () => {
    const valid = manifest();
    const invalid = {
      ...valid,
      entries: [
        valid.entries[0],
        { ...valid.entries[1], range: { start: 790, end: 900 } },
      ],
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(UpdateManifestSchema)(invalid).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
  });

  test('captures unchanged exact-path files in the first ownership baseline', () => {
    const installed = [
      { path: 'game/unchanged.bin', size: 600, sha256: hash },
      { path: 'save.dat', size: 600, sha256: hash },
    ];
    expect(
      captureOwnershipFiles(manifest(), installed, installed, undefined)
    ).toEqual([
      {
        sourcePath: 'game/unchanged.bin',
        installedPath: 'game/unchanged.bin',
        size: 600,
        sha256: hash,
      },
    ]);
  });

  test('tracks setup-generated outputs without claiming pre-existing files', () => {
    const before = [{ path: 'save.dat', size: 4, sha256: changedHash }];
    const installed = [
      ...before,
      { path: 'generated/config.ini', size: 2, sha256: generatedHash },
    ];
    expect(
      captureOwnershipFiles(manifest(), installed, before, undefined)
    ).toEqual([
      {
        installedPath: 'generated/config.ini',
        size: 2,
        sha256: generatedHash,
      },
    ]);
  });
});
