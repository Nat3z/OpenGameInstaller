import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { getTorrentInfoHash } from '../src/electron/lib/torrent-hash.js';

describe('torrent hashing', () => {
  test('resolves the info hash returned by parse-torrent', async () => {
    const hash = '0123456789abcdef0123456789abcdef01234567';
    const magnet = `magnet:?xt=urn:btih:${hash}`;

    expect(await Effect.runPromise(getTorrentInfoHash(magnet))).toBe(hash);
  });
});
