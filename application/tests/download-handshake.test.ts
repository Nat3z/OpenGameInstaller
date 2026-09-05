import { beforeAll, describe, expect, mock, test } from 'bun:test';

mock.module('@/electron/rpc/router-core.js', () => ({
  procedure: mock(() => ({})),
  router: mock(() => ({})),
}));
mock.module('@/lib/electron-rpc.js', () => ({
  ElectronRpc: { download: {} },
}));

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
