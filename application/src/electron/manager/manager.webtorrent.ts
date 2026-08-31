import { resolve as resolvePath } from 'node:path';
import { TorrentError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import webtorrent from 'webtorrent';
import { waitForTorrentFiles } from '@/electron/lib/torrent-files.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

const client = new webtorrent();
logger.sync.info(webtorrent);

type TorrentControls = {
  pause: () => void;
  resume: () => void;
  destroy: () => void;
  waitUntilFilesReady: () => Effect.Effect<void, TorrentError>;
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
          client.add(torrentId, { path }, (activeTorrent) => {
            logger.sync.info('Added torrent to download system');
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
              logger.sync.info('Torrent download finished');
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
                waitUntilFilesReady: () =>
                  Effect.tryPromise({
                    try: () =>
                      waitForTorrentFiles(
                        activeTorrent.files.map((file) => ({
                          path: resolvePath(path, file.path),
                          length: file.length,
                        }))
                      ),
                    catch: (cause) =>
                      new TorrentError({
                        message: `Torrent files did not become ready: ${String(cause)}`,
                        cause,
                      }),
                  }),
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
          client.seed(path, () => {
            logger.sync.info('Seeding torrent finished');
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
      client.seed(buffer, () => resumeEffect(Effect.void));
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
      client.destroy();
    },
    catch: (cause) =>
      new TorrentError({
        message: `Failed to stop torrent client: ${String(cause)}`,
        cause,
      }),
  });
}
