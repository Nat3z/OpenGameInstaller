import webtorrent from 'webtorrent';
let client = new webtorrent();
console.log(webtorrent);

export function torrent(torrentId: string | Buffer, path: string) {
  return {
    start: (
      onProgress: (
        downloadTotal: number,
        speed: number,
        progress: number,
        length: number,
        ratio: number
      ) => void,
      onDone: () => void
    ) =>
      new Promise<webtorrent.Torrent>((resolve, _) =>
        client.add(torrentId, { path }, async (torrent) => {
          resolve(torrent);
          // Torrents can contain many files. Download the first one.
          // get size of all files in torrent
          let length = 0;
          torrent.files.forEach((file) => {
            length += file.length;
          });
          const interval = setInterval(() => {
            const downloadTotal = torrent.downloaded;
            const speed = torrent.downloadSpeed;
            const progress = torrent.progress;
            onProgress(downloadTotal, speed, progress, length, torrent.ratio);
          });

          torrent.on('done', async () => {
            clearInterval(interval);
            console.log('Torrent download finished');
            onDone();
          });
        })
      ),
    seed: () =>
      new Promise<void>((resolve) => {
        client.seed(path, () => {
          console.log('Seeding torrent finished');
          resolve();
        });
      }),
  };
}

export function seedTorrent(buffer: Buffer): Promise<void> {
  return new Promise((resolve, _) => {
    client.seed(buffer, () => {
      resolve();
    });
  });
}

export async function stopClient(): Promise<void> {
  return new Promise(async (resolve) => {
    client.destroy();
    resolve();
  });
}
