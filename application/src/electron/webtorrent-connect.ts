import webtorrent from 'webtorrent';
let client = new webtorrent();
console.log(webtorrent)

export function addTorrent(torrentId: string | Uint8Array, path: string, onProgress: (downloadTotal: number, speed: number, progress: number, length: number, ratio: number) => void, onDone: () => void) {
  return new Promise<void>((resolve, _) => {
    client.add(torrentId, { path },  async (torrent: any) => {
      // Torrents can contain many files. Download the first one.
      // get size of all files in torrent
      let length = 0;
      torrent.files.forEach((file: any) => {
        length += file.length;
      });
      torrent.on('download', () => {
        const downloadTotal = torrent.downloaded;
        const speed = torrent.downloadSpeed;
        const progress = torrent.progress;
        onProgress(downloadTotal, speed, progress, length, torrent.ratio);
      });
      torrent.on('done', async () => {
        onDone();
        resolve();
        console.log('Torrent download finished');
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