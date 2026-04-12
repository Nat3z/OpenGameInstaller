/**
 * Tests for updater/src/artifact-utils.js
 *
 * Covers the functions added or modified in the "Harden updater artifact
 * verification" PR:
 *   - getBlockKey   (new)
 *   - takeMatchingBlock  (modified: removed size-based filtering, now pops)
 *   - verifyReleaseArtifact  (new)
 *
 * parseDigest and hashFile are also exercised indirectly through
 * verifyReleaseArtifact.
 *
 * Run with:  node --test test/artifact-utils.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import {
  getBlockKey,
  takeMatchingBlock,
  verifyReleaseArtifact,
  parseDigest,
} from '../src/artifact-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Synchronously write content to a temp file and return its path.
 * Keeps a registry so callers can clean up via cleanup().
 */
const tmpFiles = [];
function writeTmpFile(content) {
  const p = path.join(os.tmpdir(), `artifact-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}

function cleanup() {
  for (const p of tmpFiles) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
}

function sha256hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

function sha384hex(content) {
  return createHash('sha384').update(content).digest('hex');
}

function sha512hex(content) {
  return createHash('sha512').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// getBlockKey
// ---------------------------------------------------------------------------

describe('getBlockKey', () => {
  it('combines checksum and size with a colon separator', () => {
    assert.equal(getBlockKey('abc123', 512), 'abc123:512');
  });

  it('works with an empty string checksum', () => {
    assert.equal(getBlockKey('', 1024), ':1024');
  });

  it('works with a zero size', () => {
    assert.equal(getBlockKey('deadbeef', 0), 'deadbeef:0');
  });

  it('works with a base64 checksum containing slashes and plusses', () => {
    const b64 = 'a/b+c==';
    assert.equal(getBlockKey(b64, 4096), `${b64}:4096`);
  });

  it('works with a large size value', () => {
    assert.equal(getBlockKey('ff00', 2 ** 32), `ff00:${2 ** 32}`);
  });

  it('returns a string for numeric-like checksum inputs', () => {
    // checksum is always a string in practice; coercion via template literal
    assert.equal(typeof getBlockKey('123', 8), 'string');
    assert.equal(getBlockKey('123', 8), '123:8');
  });

  it('produces different keys for identical checksums with different sizes', () => {
    const k1 = getBlockKey('aabbcc', 100);
    const k2 = getBlockKey('aabbcc', 200);
    assert.notEqual(k1, k2);
  });

  it('produces different keys for same size but different checksums', () => {
    const k1 = getBlockKey('aabb', 100);
    const k2 = getBlockKey('ccdd', 100);
    assert.notEqual(k1, k2);
  });

  it('is deterministic – same inputs always yield same output', () => {
    assert.equal(getBlockKey('xyz', 99), getBlockKey('xyz', 99));
  });
});

// ---------------------------------------------------------------------------
// takeMatchingBlock
// ---------------------------------------------------------------------------

describe('takeMatchingBlock', () => {
  it('returns null for null', () => {
    assert.equal(takeMatchingBlock(null), null);
  });

  it('returns null for undefined', () => {
    assert.equal(takeMatchingBlock(undefined), null);
  });

  it('returns null for an empty array', () => {
    assert.equal(takeMatchingBlock([]), null);
  });

  it('returns null for a non-array string', () => {
    assert.equal(takeMatchingBlock('block'), null);
  });

  it('returns null for a non-array number', () => {
    assert.equal(takeMatchingBlock(42), null);
  });

  it('returns null for a plain object', () => {
    assert.equal(takeMatchingBlock({ offset: 0, size: 512 }), null);
  });

  it('pops and returns the only element from a single-element array', () => {
    const block = { offset: 0, size: 512 };
    const blocks = [block];
    const result = takeMatchingBlock(blocks);
    assert.deepEqual(result, block);
    assert.equal(blocks.length, 0, 'array should be empty after pop');
  });

  it('pops and returns the LAST element from a multi-element array (LIFO)', () => {
    const b1 = { offset: 0,    size: 512 };
    const b2 = { offset: 512,  size: 512 };
    const b3 = { offset: 1024, size: 512 };
    const blocks = [b1, b2, b3];
    const result = takeMatchingBlock(blocks);
    assert.deepEqual(result, b3, 'should return the last block');
    assert.equal(blocks.length, 2, 'array should have two elements remaining');
  });

  it('mutates the source array by removing the returned element', () => {
    const b1 = { offset: 0, size: 256 };
    const b2 = { offset: 256, size: 256 };
    const blocks = [b1, b2];
    takeMatchingBlock(blocks);
    assert.deepEqual(blocks, [b1], 'only first block should remain');
  });

  it('returns null after all elements have been consumed', () => {
    const blocks = [{ offset: 0, size: 1 }];
    takeMatchingBlock(blocks); // consumes the only element
    assert.equal(takeMatchingBlock(blocks), null);
  });

  it('does not care about block sizes – pops regardless of size', () => {
    // Prior to this PR the function filtered by expectedSize; now it just pops.
    const b1 = { offset: 0,   size: 100 };
    const b2 = { offset: 100, size: 200 };
    const blocks = [b1, b2];
    // Should return b2 (the last one), even though b1 has a different size.
    const result = takeMatchingBlock(blocks);
    assert.deepEqual(result, b2);
  });

  it('works correctly when called repeatedly until array is drained', () => {
    const blocks = [
      { offset: 0, size: 1 },
      { offset: 1, size: 2 },
      { offset: 3, size: 3 },
    ];
    const r1 = takeMatchingBlock(blocks);
    const r2 = takeMatchingBlock(blocks);
    const r3 = takeMatchingBlock(blocks);
    const r4 = takeMatchingBlock(blocks);
    assert.equal(r1.offset, 3);
    assert.equal(r2.offset, 1);
    assert.equal(r3.offset, 0);
    assert.equal(r4, null);
  });
});

// ---------------------------------------------------------------------------
// verifyReleaseArtifact
// ---------------------------------------------------------------------------

describe('verifyReleaseArtifact', () => {
  after(cleanup);

  // --- size-check tests ----------------------------------------------------

  it('throws when file does not exist (fs.statSync error propagated)', async () => {
    await assert.rejects(
      () => verifyReleaseArtifact('/nonexistent/path/to/file.bin', {}),
      (err) => err instanceof Error
    );
  });

  it('throws with informative message on size mismatch using default label', async () => {
    const content = 'hello world';
    const filePath = writeTmpFile(content);
    const actualSize = Buffer.byteLength(content);
    const wrongSize = actualSize + 100;

    await assert.rejects(
      () => verifyReleaseArtifact(filePath, { size: wrongSize }),
      (err) => {
        assert.match(err.message, /size mismatch/);
        assert.match(err.message, /release artifact/);  // default logLabel
        assert.match(err.message, new RegExp(String(wrongSize)));
        assert.match(err.message, new RegExp(String(actualSize)));
        return true;
      }
    );
  });

  it('includes custom logLabel in size-mismatch error', async () => {
    const filePath = writeTmpFile('data');
    await assert.rejects(
      () => verifyReleaseArtifact(filePath, { size: 9999 }, 'my custom artifact'),
      (err) => {
        assert.match(err.message, /my custom artifact/);
        return true;
      }
    );
  });

  it('resolves without error when size matches and no digest provided', async () => {
    const content = 'test content';
    const filePath = writeTmpFile(content);
    const size = Buffer.byteLength(content);
    await assert.doesNotReject(() => verifyReleaseArtifact(filePath, { size }));
  });

  it('skips size check when expectedArtifact.size is 0', async () => {
    const filePath = writeTmpFile('some data');
    // size=0 should bypass the size check entirely (guard: size > 0)
    await assert.doesNotReject(() => verifyReleaseArtifact(filePath, { size: 0 }));
  });

  it('skips size check when expectedArtifact.size is undefined', async () => {
    const filePath = writeTmpFile('some data');
    await assert.doesNotReject(() => verifyReleaseArtifact(filePath, {}));
  });

  it('skips size check when expectedArtifact.size is NaN', async () => {
    const filePath = writeTmpFile('some data');
    await assert.doesNotReject(() => verifyReleaseArtifact(filePath, { size: NaN }));
  });

  it('skips size check when expectedArtifact.size is Infinity', async () => {
    const filePath = writeTmpFile('some data');
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { size: Infinity })
    );
  });

  it('skips size check when expectedArtifact.size is negative', async () => {
    // Negative sizes are not finite-positive, so the guard (size > 0) skips them.
    // Actually the guard checks size > 0 after isFinite, -1 is finite but fails > 0.
    const filePath = writeTmpFile('abc');
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { size: -1 })
    );
  });

  // --- digest-check tests --------------------------------------------------

  it('resolves when digest is undefined (no digest to check)', async () => {
    const filePath = writeTmpFile('no digest needed');
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { size: undefined })
    );
  });

  it('resolves when digest is an invalid/unknown algorithm', async () => {
    const filePath = writeTmpFile('content');
    // parseDigest returns null for unknown algorithms; should just log and return
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { digest: 'md5:abcdef' })
    );
  });

  it('resolves when digest string has wrong format (no colon)', async () => {
    const filePath = writeTmpFile('content');
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { digest: 'notadigest' })
    );
  });

  it('resolves with correct sha256 digest', async () => {
    const content = 'verify me with sha256';
    const filePath = writeTmpFile(content);
    const hex = sha256hex(content);
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { digest: `sha256:${hex}` })
    );
  });

  it('resolves with correct sha384 digest', async () => {
    const content = 'verify me with sha384';
    const filePath = writeTmpFile(content);
    const hex = sha384hex(content);
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { digest: `sha384:${hex}` })
    );
  });

  it('resolves with correct sha512 digest', async () => {
    const content = 'verify me with sha512';
    const filePath = writeTmpFile(content);
    const hex = sha512hex(content);
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { digest: `sha512:${hex}` })
    );
  });

  it('throws on wrong sha256 digest with algorithm name in error', async () => {
    const filePath = writeTmpFile('real content');
    await assert.rejects(
      () =>
        verifyReleaseArtifact(filePath, {
          digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        }),
      (err) => {
        assert.match(err.message, /digest mismatch/);
        assert.match(err.message, /sha256/);
        return true;
      }
    );
  });

  it('throws on wrong sha384 digest', async () => {
    const filePath = writeTmpFile('real content');
    const badHex = '0'.repeat(96);
    await assert.rejects(
      () => verifyReleaseArtifact(filePath, { digest: `sha384:${badHex}` }),
      (err) => {
        assert.match(err.message, /sha384/);
        return true;
      }
    );
  });

  it('throws on wrong sha512 digest', async () => {
    const filePath = writeTmpFile('real content');
    const badHex = '0'.repeat(128);
    await assert.rejects(
      () => verifyReleaseArtifact(filePath, { digest: `sha512:${badHex}` }),
      (err) => {
        assert.match(err.message, /sha512/);
        return true;
      }
    );
  });

  it('includes custom logLabel in digest-mismatch error', async () => {
    const filePath = writeTmpFile('content');
    const badHex = '0'.repeat(64);
    await assert.rejects(
      () =>
        verifyReleaseArtifact(
          filePath,
          { digest: `sha256:${badHex}` },
          'the patched artifact'
        ),
      (err) => {
        assert.match(err.message, /the patched artifact/);
        return true;
      }
    );
  });

  it('is case-insensitive for the algorithm prefix', async () => {
    const content = 'case insensitive';
    const filePath = writeTmpFile(content);
    const hex = sha256hex(content);
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { digest: `SHA256:${hex}` })
    );
  });

  it('passes both size and correct digest together', async () => {
    const content = 'combined check';
    const filePath = writeTmpFile(content);
    const size = Buffer.byteLength(content);
    const hex = sha256hex(content);
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { size, digest: `sha256:${hex}` })
    );
  });

  it('fails size check before reaching digest check', async () => {
    const content = 'size first';
    const filePath = writeTmpFile(content);
    const size = Buffer.byteLength(content);
    const hex = sha256hex(content);
    // Pass correct digest but wrong size – should fail on size
    await assert.rejects(
      () =>
        verifyReleaseArtifact(filePath, {
          size: size + 1,
          digest: `sha256:${hex}`,
        }),
      (err) => {
        assert.match(err.message, /size mismatch/);
        return true;
      }
    );
  });

  it('handles an empty file with size=0 and correct digest', async () => {
    const filePath = writeTmpFile('');
    const hex = sha256hex('');
    // size=0 skips size check; digest check should still pass
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { size: 0, digest: `sha256:${hex}` })
    );
  });

  it('handles an empty file with wrong digest', async () => {
    const filePath = writeTmpFile('');
    await assert.rejects(
      () =>
        verifyReleaseArtifact(filePath, {
          digest: `sha256:${'1'.repeat(64)}`,
        }),
      (err) => {
        assert.match(err.message, /digest mismatch/);
        return true;
      }
    );
  });

  // Regression test: verifyReleaseArtifact should resolve without throwing
  // when the file matches the expected size and digest precisely.
  it('regression: resolves cleanly for a known-good artifact', async () => {
    const content = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const filePath = writeTmpFile(content);
    const size = content.length;
    const hex = createHash('sha256').update(content).digest('hex');
    await assert.doesNotReject(() =>
      verifyReleaseArtifact(filePath, { size, digest: `sha256:${hex}` })
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: getBlockKey used in checksumToBlocks map (behavioral test)
// ---------------------------------------------------------------------------

describe('getBlockKey – checksumToBlocks map integration', () => {
  /**
   * This group mirrors the exact pattern used inside applyBlockmapPatch to
   * build the old-block lookup map. The PR changed the key from just
   * `checksum` to `getBlockKey(checksum, size)` so that blocks with the same
   * checksum but different sizes don't collide.
   */

  it('blocks with the same checksum but different sizes get separate map entries', () => {
    const checksums = ['aaaa', 'aaaa'];
    const sizes = [100, 200];

    const checksumToBlocks = new Map();
    let offset = 0;
    for (let i = 0; i < checksums.length; i++) {
      const key = getBlockKey(checksums[i], sizes[i]);
      const block = { offset, size: sizes[i] };
      const current = checksumToBlocks.get(key) || [];
      current.push(block);
      checksumToBlocks.set(key, current);
      offset += sizes[i];
    }

    assert.equal(checksumToBlocks.size, 2, 'should have two distinct keys');
    const blocksFor100 = checksumToBlocks.get(getBlockKey('aaaa', 100));
    const blocksFor200 = checksumToBlocks.get(getBlockKey('aaaa', 200));
    assert.equal(blocksFor100.length, 1);
    assert.equal(blocksFor200.length, 1);
    assert.equal(blocksFor100[0].offset, 0);
    assert.equal(blocksFor200[0].offset, 100);
  });

  it('identical checksum AND size accumulate under the same key', () => {
    const key1 = getBlockKey('bbbb', 512);
    const key2 = getBlockKey('bbbb', 512);
    assert.equal(key1, key2);

    const map = new Map();
    [
      { offset: 0,   size: 512 },
      { offset: 512, size: 512 },
    ].forEach((block) => {
      const current = map.get(key1) || [];
      current.push(block);
      map.set(key1, current);
    });

    assert.equal(map.size, 1);
    assert.equal(map.get(key1).length, 2);
  });

  it('takeMatchingBlock + getBlockKey lookup matches new-block sizes without size revalidation', () => {
    // Old code: takeMatchingBlock(blocks, expectedSize) – filtered by size.
    // New code: takeMatchingBlock(blocks) – just pops, no size filter.
    // Since getBlockKey now encodes the size in the key, the map lookup
    // already ensures size compatibility before takeMatchingBlock is called.

    const oldChecksums = ['c1', 'c2'];
    const oldSizes    = [100, 200];
    const map = new Map();
    let offset = 0;
    for (let i = 0; i < oldChecksums.length; i++) {
      const key = getBlockKey(oldChecksums[i], oldSizes[i]);
      const block = { offset, size: oldSizes[i] };
      const list = map.get(key) || [];
      list.push(block);
      map.set(key, list);
      offset += oldSizes[i];
    }

    // Simulate new-file lookup: checksum='c1', size=100 → should find the right block
    const newChecksum = 'c1';
    const newSize     = 100;
    const blocks = map.get(getBlockKey(newChecksum, newSize));
    const matched = takeMatchingBlock(blocks);
    assert.ok(matched, 'should find a matching block');
    assert.equal(matched.offset, 0);
    assert.equal(matched.size,  100);

    // Simulate new-file lookup: checksum='c1', size=200 → should NOT find a block
    const blocksWrongSize = map.get(getBlockKey('c1', 200));
    assert.equal(takeMatchingBlock(blocksWrongSize), null);
  });
});