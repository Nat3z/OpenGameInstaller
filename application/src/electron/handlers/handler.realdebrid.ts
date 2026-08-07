import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystemError, formatError, HttpError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import axios from 'axios';
import { Effect, Schema } from 'effect';
import type { ReadStream } from 'original-fs';
import RealDebrid from 'real-debrid-js';
import { sendNotification } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { procedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary } from '@/electron/runtime.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

const CONFIG_PATH = join(__dirname, 'config/option/realdebrid.json');
const ConfigSchema = Schema.Struct({ debridApiKey: Schema.String });
let realDebridClient = new RealDebrid({ apiKey: 'UNSET' });

const hostName = (host: unknown): string | undefined =>
  typeof host === 'string'
    ? host
    : host &&
        typeof host === 'object' &&
        'host' in host &&
        typeof host.host === 'string'
      ? host.host
      : undefined;

const notifyFailure = <A, E>(
  effect: Effect.Effect<A, E>,
  message: string
): Effect.Effect<A | null> =>
  effect.pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        logger.sync.error(error);
        sendNotification({
          message,
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        return null;
      })
    )
  );

const run = <A, E>(effect: Effect.Effect<A, E>, message: string) =>
  runEffectBoundary(notifyFailure(effect, message));

const updateKey = () =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => fsAsync.readFile(CONFIG_PATH, 'utf-8'),
      catch: (cause) =>
        new FileSystemError({
          message: formatError(cause),
          path: CONFIG_PATH,
          cause,
        }),
    });
    const unknown = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new FileSystemError({
          message: formatError(cause),
          path: CONFIG_PATH,
          cause,
        }),
    });
    const config = yield* Schema.decodeUnknown(ConfigSchema)(unknown).pipe(
      Effect.mapError(
        (cause) =>
          new FileSystemError({
            message: String(cause),
            path: CONFIG_PATH,
            cause,
          })
      )
    );
    realDebridClient = new RealDebrid({ apiKey: config.debridApiKey });
    return true;
  });

const downloadTorrent = (url: string, path: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        axios.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
          timeout: 60_000,
        }),
      catch: (cause: unknown) =>
        new HttpError({
          message: axios.isAxiosError(cause)
            ? cause.message
            : formatError(cause),
          statusCode: axios.isAxiosError(cause)
            ? (cause.response?.status ?? 0)
            : 0,
          url,
        }),
    });
    yield* Effect.tryPromise({
      try: () => fsAsync.writeFile(path, Buffer.from(response.data)),
      catch: (cause) =>
        new FileSystemError({ message: formatError(cause), path, cause }),
    });
  });

export default function handler(mainWindow: Electron.BrowserWindow) {
  return router(
    procedure(ElectronRpc.realdebrid.setKey, (key: string) =>
      run(
        Effect.sync(() => {
          realDebridClient = new RealDebrid({ apiKey: key });
          return 'success' as const;
        }),
        'Failed to set Real-Debrid key'
      )
    ),
    procedure(ElectronRpc.realdebrid.updateKey, () =>
      run(updateKey(), 'Failed to update Real-Debrid key')
    ),
    procedure(ElectronRpc.realdebrid.addMagnet, (url: string, host?: string) =>
      run(
        realDebridClient.addMagnet(url, hostName(host)),
        'Failed to add Real-Debrid magnet'
      )
    ),
    procedure(ElectronRpc.realdebrid.getUserInfo, () =>
      run(
        realDebridClient.getUserInfo(),
        'Failed to fetch Real-Debrid user info'
      )
    ),
    procedure(ElectronRpc.realdebrid.unrestrictLink, (link: string) =>
      run(
        realDebridClient.unrestrictLink(link),
        'Failed to unrestrict Real-Debrid link'
      )
    ),
    procedure(ElectronRpc.realdebrid.getHosts, () =>
      run(realDebridClient.getHosts(), 'Failed to fetch Real-Debrid hosts')
    ),
    procedure(ElectronRpc.realdebrid.getTorrentInfo, (id: string) =>
      run(
        realDebridClient.getTorrentInfo(id),
        'Failed to fetch Real-Debrid torrent info'
      )
    ),
    procedure(ElectronRpc.realdebrid.isTorrentReady, (id: string) =>
      run(
        realDebridClient.isTorrentReady(id),
        'Failed to check Real-Debrid torrent status'
      )
    ),
    procedure(ElectronRpc.realdebrid.selectTorrent, (id: string) =>
      run(
        realDebridClient.selectTorrents(id),
        'Failed to select Real-Debrid torrent'
      )
    ),
    procedure(
      ElectronRpc.realdebrid.addTorrent,
      (torrent: string, host?: string) => {
        const tempPath = join(
          __dirname,
          `temp-realdebrid-${Date.now()}.torrent`
        );
        const operation = Effect.gen(function* () {
          yield* downloadTorrent(torrent, tempPath);
          const stream = fs.createReadStream(tempPath) as ReadStream;
          return yield* realDebridClient
            .addTorrent(stream, hostName(host))
            .pipe(Effect.ensuring(Effect.sync(() => stream.destroy())));
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              mainWindow?.webContents?.send('ddl:download-error', {
                id: Math.random().toString(36).slice(2),
                error: formatError(error),
              });
            })
          ),
          Effect.ensuring(
            Effect.promise(() => fsAsync.rm(tempPath, { force: true }))
          )
        );
        return run(operation, 'Failed to add torrent to Real-Debrid');
      }
    )
  );
}
