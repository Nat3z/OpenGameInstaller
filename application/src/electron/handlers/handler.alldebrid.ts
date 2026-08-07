import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystemError, formatError, HttpError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import AllDebrid from 'all-debrid-js';
import axios from 'axios';
import { Effect, Schema } from 'effect';
import type { ReadStream } from 'original-fs';
import { sendNotification } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { procedure, router } from '@/electron/rpc/router-core.js';
import { runEffectBoundary } from '@/electron/runtime.js';
import { ElectronRpc } from '@/lib/electron-rpc.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

const CONFIG_PATH = join(__dirname, 'config/option/realdebrid.json');
const ConfigSchema = Schema.Struct({
  alldebridApiKey: Schema.optional(Schema.String),
});
let allDebridClient = new AllDebrid({ apiKey: 'UNSET' });

const readKey = () =>
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
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new FileSystemError({
          message: formatError(cause),
          path: CONFIG_PATH,
          cause,
        }),
    });
    const config = yield* Schema.decodeUnknown(ConfigSchema)(json).pipe(
      Effect.mapError(
        (cause) =>
          new FileSystemError({
            message: String(cause),
            path: CONFIG_PATH,
            cause,
          })
      )
    );
    return config.alldebridApiKey ?? null;
  });

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
    const buffer = Buffer.from(response.data);
    if (buffer.byteLength > 10 * 1024 * 1024) {
      return yield* Effect.fail(
        new HttpError({
          message: 'Torrent exceeds 10MB size limit',
          statusCode: 413,
          url,
        })
      );
    }
    yield* Effect.tryPromise({
      try: () => fsAsync.writeFile(path, buffer),
      catch: (cause) =>
        new FileSystemError({ message: formatError(cause), path, cause }),
    });
  });

const run = <A, E>(effect: Effect.Effect<A, E>, message: string) =>
  runEffectBoundary(notifyFailure(effect, message));

export default function handler(_mainWindow: Electron.BrowserWindow) {
  return router(
    procedure(ElectronRpc.alldebrid.setKey, (key: string) =>
      run(
        Effect.sync(() => {
          allDebridClient = new AllDebrid({ apiKey: key });
          return 'success' as const;
        }),
        'Failed to set AllDebrid key'
      )
    ),
    procedure(ElectronRpc.alldebrid.updateKey, () =>
      run(
        readKey().pipe(
          Effect.map((key) => {
            if (!key) return false;
            allDebridClient = new AllDebrid({ apiKey: key });
            return true;
          })
        ),
        'Failed to update AllDebrid key'
      )
    ),
    procedure(ElectronRpc.alldebrid.getUserInfo, () =>
      run(allDebridClient.getUserInfo(), 'Failed to fetch AllDebrid user info')
    ),
    procedure(ElectronRpc.alldebrid.getHosts, () =>
      run(allDebridClient.getHosts(), 'Failed to fetch AllDebrid hosts')
    ),
    procedure(ElectronRpc.alldebrid.addMagnet, (url: string, host?: string) =>
      run(
        allDebridClient.addMagnet(url, host),
        'Failed to add magnet to AllDebrid'
      )
    ),
    procedure(ElectronRpc.alldebrid.isTorrentReady, (id: string) =>
      run(
        allDebridClient.isTorrentReady(id),
        'Failed to check AllDebrid torrent status'
      )
    ),
    procedure(ElectronRpc.alldebrid.getTorrentInfo, (id: string) =>
      run(
        allDebridClient.getMagnetFiles(id),
        'Failed to fetch AllDebrid torrent info'
      )
    ),
    procedure(ElectronRpc.alldebrid.unrestrictLink, (link: string) =>
      run(
        allDebridClient.unrestrictLink(link),
        'Failed to unrestrict AllDebrid link'
      )
    ),
    procedure(ElectronRpc.alldebrid.selectTorrent, () =>
      runEffectBoundary(Effect.succeed(true))
    ),
    procedure(ElectronRpc.alldebrid.addTorrent, (torrent: string) => {
      const tempPath = join(__dirname, `temp-alldebrid-${Date.now()}.torrent`);
      const operation = Effect.gen(function* () {
        yield* downloadTorrent(torrent, tempPath);
        const stream = fs.createReadStream(tempPath) as ReadStream;
        return yield* allDebridClient
          .addTorrent(stream)
          .pipe(Effect.ensuring(Effect.sync(() => stream.destroy())));
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => fsAsync.rm(tempPath, { force: true }))
        )
      );
      return run(operation, 'Failed to add torrent to AllDebrid');
    })
  );
}
