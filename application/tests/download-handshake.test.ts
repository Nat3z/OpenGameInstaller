import { beforeAll, describe, expect, mock, test } from 'bun:test';

// src/lib has no tsconfig of its own, so its `@/` imports don't resolve
// under bun test. Point the aliases at the real modules rather than stubs so
// suites sharing this process still see the real router and RPC schema.
mock.module('@/electron/rpc/router-core.js', () =>
  require('../src/electron/rpc/router-core.js')
);
mock.module('@/lib/electron-rpc.js', () => require('../src/lib/electron-rpc.js'));

let handshake: typeof import('../src/lib/download-handshake.js');

beforeAll(async () => {
  handshake = await import('../src/lib/download-handshake.js');
});

describe('download handshake replay', () => {
  test('buffers a terminal event when the initial state was already ready', async () => {
    const id = 'already-downloading';
    handshake.registerDownloadHandshake(id);
    handshake.updateDownloadHandshake({ id, status: 'downloading' });

    await handshake.waitForDownloadHandshake(id);
    handshake.updateDownloadHandshake(
      { id, status: 'seeding' },
      { channel: 'torrent:download-complete', data: { id } }
    );

    expect(handshake.consumeDownloadReplayEvents(id)).toEqual([
      { channel: 'torrent:download-complete', data: { id } },
    ]);
  });
});
