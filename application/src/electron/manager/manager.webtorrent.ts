import { TorrentError } from '@ogi/errors';
import { Effect } from 'effect';
import webtorrent from 'webtorrent';

type WebTorrentOptions = ConstructorParameters<typeof webtorrent>[0] & {
  torrentPort?: number;
  natUpnp?: boolean;
  natPmp?: boolean;
  uploadLimit?: number;
};

let client: InstanceType<typeof webtorrent> | undefined;
let clientOptions: WebTorrentOptions | undefined;

export function configureWebTorrentClient(options: WebTorrentOptions): void {
  if (client) {
    throw new Error('WebTorrent client is already initialized');
  }
  clientOptions = { ...options };
}

function getClient(): InstanceType<typeof webtorrent> {
  client ??= new webtorrent(clientOptions);
  return client;
}

type TorrentControls = {
  pause: () => void;
  resume: () => void;
  destroy: () => void;
};

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
    ): Effect.Effect<TorrentControls, TorrentError> =>
      Effect.async<TorrentControls, TorrentError>((resumeEffect) => {
        try {
          getClient().add(torrentId, { path }, (activeTorrent) => {
            console.log('Added torrent to download system');
            const length = activeTorrent.files.reduce(
              (total, file) => total + file.length,
              0
            );

            let interval: NodeJS.Timeout | undefined;
            let isPaused = false;

            const startProgressReporting = () => {
              if (interval) clearInterval(interval);
              interval = setInterval(() => {
                if (!isPaused) {
                  onProgress(
                    activeTorrent.downloaded,
                    activeTorrent.downloadSpeed,
                    activeTorrent.progress,
                    length,
                    activeTorrent.ratio
                  );
                }
              }, 100);
            };

            const stopProgressReporting = () => {
              if (interval) clearInterval(interval);
            };

            startProgressReporting();
            activeTorrent.on('done', () => {
              stopProgressReporting();
              console.log('Torrent download finished');
              onDone();
            });

            resumeEffect(
              Effect.succeed({
                pause: () => {
                  isPaused = true;
                  stopProgressReporting();
                  activeTorrent.files.forEach((file) => file.deselect());
                  activeTorrent.pause();
                },
                resume: () => {
                  isPaused = false;
                  startProgressReporting();
                  activeTorrent.files.forEach((file) => file.select());
                  activeTorrent.resume();
                },
                destroy: () => {
                  stopProgressReporting();
                  activeTorrent.destroy();
                },
              })
            );
          });
        } catch (cause) {
          resumeEffect(
            Effect.fail(
              new TorrentError({
                message: `Failed to add torrent: ${String(cause)}`,
                cause,
              })
            )
          );
        }
      }),
    seed: (): Effect.Effect<void, TorrentError> =>
      Effect.async<void, TorrentError>((resumeEffect) => {
        try {
          getClient().seed(path, () => {
            console.log('Seeding torrent finished');
            resumeEffect(Effect.void);
          });
        } catch (cause) {
          resumeEffect(
            Effect.fail(
              new TorrentError({
                message: `Failed to seed torrent: ${String(cause)}`,
                cause,
              })
            )
          );
        }
      }),
  };
}

export function seedTorrent(buffer: Buffer): Effect.Effect<void, TorrentError> {
  return Effect.async<void, TorrentError>((resumeEffect) => {
    try {
      getClient().seed(buffer, () => resumeEffect(Effect.void));
    } catch (cause) {
      resumeEffect(
        Effect.fail(
          new TorrentError({
            message: `Failed to seed torrent: ${String(cause)}`,
            cause,
          })
        )
      );
    }
  });
}

export function stopClient(): Effect.Effect<void, TorrentError> {
  return Effect.try({
    try: () => {
      const activeClient = client;
      client = undefined;
      activeClient?.destroy();
    },
    catch: (cause) =>
      new TorrentError({
        message: `Failed to stop torrent client: ${String(cause)}`,
        cause,
      }),
  });
}
