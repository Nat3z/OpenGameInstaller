let client: any;
(async () => {
  const webtorrent = await import('webtorrent');
  client = new webtorrent();
})();

export function addTorrent(torrentId: string | Uint8Array, path: string, onProgress: (downloadTotal: number, speed: number, progress: number, length: number) => void, onDone: () => void) {
  return new Promise<void>((resolve, _) => {
    client.add(torrentId, { path },  async (torrent: any) => {
      // Torrents can contain many files. Download the first one.
      const file = torrent.files[0];
      torrent.on('download', () => {
        const downloadTotal = torrent.downloaded;
        const speed = torrent.downloadSpeed;
        const progress = torrent.progress;
        const length = file.length;
        onProgress(downloadTotal, speed, progress, length);
      });
      torrent.on('done', async () => {
        onDone();
        resolve();
      });

    });
  });
}

export function seedTorrent(buffer: Buffer): Promise<void> {
  return new Promise((resolve, _) => {
    client.seed(buffer, () => {
      resolve()
    });
  });
}

export async function stopClient(): Promise<void> {
  return new Promise(async (resolve) => {
    await client.destroy();
    resolve();
  });
}