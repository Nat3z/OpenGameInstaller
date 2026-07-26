import webtorrent from 'webtorrent';

type WebTorrentOptions = ConstructorParameters<typeof webtorrent>[0] & {
  torrentPort?: number;
  natUpnp?: boolean;
  natPmp?: boolean;
  uploadLimit?: number;
};

let client: InstanceType<typeof webtorrent> | undefined;
let clientOptions: WebTorrentOptions | undefined;

export function configureWebTorrentClient(options: WebTorrentOptions) {
  if (client) {
    throw new Error('WebTorrent client is already initialized');
  }
  clientOptions = { ...options };
}

function getClient() {
  client ??= new webtorrent(clientOptions);
  return client;
}

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
      new Promise<{
        pause: () => void;
        resume: () => void;
        destroy: () => void;
      }>((resolve, _) =>
        getClient().add(torrentId, { path }, async (torrent) => {
          console.log('Added torrent to download system');
          // Torrents can contain many files. Download the first one.
          // get size of all files in torrent
          let length = 0;
          torrent.files.forEach((file) => {
            length += file.length;
          });

          let interval: NodeJS.Timeout;
          let isPaused = false;

          const startProgressReporting = () => {
            if (interval) clearInterval(interval);
            interval = setInterval(() => {
              if (!isPaused) {
                const downloadTotal = torrent.downloaded;
                const speed = torrent.downloadSpeed;
                const progress = torrent.progress;
                onProgress(
                  downloadTotal,
                  speed,
                  progress,
                  length,
                  torrent.ratio
                );
              }
            }, 100);
          };

          const stopProgressReporting = () => {
            if (interval) {
              clearInterval(interval);
            }
          };

          startProgressReporting();

          torrent.on('done', async () => {
            stopProgressReporting();
            console.log('Torrent download finished');
            onDone();
          });

          // Return control object with pause/resume/destroy methods
          resolve({
            pause: () => {
              isPaused = true;
              stopProgressReporting();
              // Pause all file downloads by deselecting them
              torrent.files.forEach((file) => {
                file.deselect();
              });
              // Also use the native pause method
              torrent.pause();
            },
            resume: () => {
              isPaused = false;
              startProgressReporting();
              // Resume all file downloads by selecting them
              torrent.files.forEach((file) => {
                file.select();
              });
              // Also use the native resume method
              torrent.resume();
            },
            destroy: () => {
              stopProgressReporting();
              torrent.destroy();
            },
          });
        })
      ),
    seed: () =>
      new Promise<void>((resolve) => {
        getClient().seed(path, () => {
          console.log('Seeding torrent finished');
          resolve();
        });
      }),
  };
}

export function seedTorrent(buffer: Buffer): Promise<void> {
  return new Promise((resolve, _) => {
    getClient().seed(buffer, () => {
      resolve();
    });
  });
}

export async function stopClient(): Promise<void> {
  const activeClient = client;
  client = undefined;
  if (!activeClient) return;
  await new Promise<void>((resolve, reject) => {
    activeClient.destroy((error) => (error ? reject(error) : resolve()));
  });
}
