import axios from 'axios';
import { ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadStream } from 'original-fs';
import RealDebrid from 'real-debrid-js';
import { FileSystemError, HttpError, formatError } from '@ogi/errors';
import { Effect, Schema } from 'effect';
import { sendNotification } from '@/electron/main.js';
import { __dirname } from '@/electron/manager/manager.paths.js';

const CONFIG_PATH = join(__dirname, 'config/option/realdebrid.json');
const ConfigSchema = Schema.Struct({ debridApiKey: Schema.String });
let realDebridClient = new RealDebrid({ apiKey: 'UNSET' });

const hostName = (host: unknown): string | undefined =>
  typeof host === 'string' ? host
    : host && typeof host === 'object' && 'host' in host && typeof host.host === 'string' ? host.host : undefined;

const notifyFailure = <A, E>(effect: Effect.Effect<A, E>, message: string): Effect.Effect<A | null> =>
  effect.pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.error(error);
    sendNotification({ message, id: Math.random().toString(36).substring(7), type: 'error' });
    return null;
  })));

const run = <A, E>(effect: Effect.Effect<A, E>, message: string) =>
  Effect.runPromise(notifyFailure(effect, message));

const updateKey = () => Effect.gen(function* () {
  const raw = yield* Effect.tryPromise({
    try: () => fsAsync.readFile(CONFIG_PATH, 'utf-8'),
    catch: (cause) => new FileSystemError({ message: formatError(cause), path: CONFIG_PATH, cause }),
  });
  const unknown = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => new FileSystemError({ message: formatError(cause), path: CONFIG_PATH, cause }),
  });
  const config = yield* Schema.decodeUnknown(ConfigSchema)(unknown).pipe(
    Effect.mapError((cause) => new FileSystemError({ message: String(cause), path: CONFIG_PATH, cause }))
  );
  realDebridClient = new RealDebrid({ apiKey: config.debridApiKey });
  return true;
});

const downloadTorrent = (url: string, path: string) => Effect.gen(function* () {
  const response = yield* Effect.tryPromise({
    try: () => axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 60_000 }),
    catch: (cause: any) => new HttpError({ message: cause?.message ?? 'Torrent download failed', statusCode: cause?.response?.status ?? 0, url }),
  });
  yield* Effect.tryPromise({
    try: () => fsAsync.writeFile(path, Buffer.from(response.data)),
    catch: (cause) => new FileSystemError({ message: formatError(cause), path, cause }),
  });
});

export default function handler(mainWindow: Electron.BrowserWindow): void {
  ipcMain.handle('real-debrid:set-key', (_, key: string) => run(Effect.sync(() => {
    realDebridClient = new RealDebrid({ apiKey: key }); return 'success' as const;
  }), 'Failed to set Real-Debrid key'));
  ipcMain.handle('real-debrid:update-key', () => run(updateKey(), 'Failed to update Real-Debrid key'));
  ipcMain.handle('real-debrid:add-magnet', (_, arg) => run(realDebridClient.addMagnet(arg.url, hostName(arg.host)), 'Failed to add Real-Debrid magnet'));
  ipcMain.handle('real-debrid:get-user-info', () => run(realDebridClient.getUserInfo(), 'Failed to fetch Real-Debrid user info'));
  ipcMain.handle('real-debrid:unrestrict-link', (_, link) => run(realDebridClient.unrestrictLink(link), 'Failed to unrestrict Real-Debrid link'));
  ipcMain.handle('real-debrid:get-hosts', () => run(realDebridClient.getHosts(), 'Failed to fetch Real-Debrid hosts'));
  ipcMain.handle('real-debrid:get-torrent-info', (_, id) => run(realDebridClient.getTorrentInfo(id), 'Failed to fetch Real-Debrid torrent info'));
  ipcMain.handle('real-debrid:is-torrent-ready', (_, id) => run(realDebridClient.isTorrentReady(id), 'Failed to check Real-Debrid torrent status'));
  ipcMain.handle('real-debrid:select-torrent', (_, id) => run(realDebridClient.selectTorrents(id), 'Failed to select Real-Debrid torrent'));
  ipcMain.handle('real-debrid:add-torrent', (_, arg) => {
    const tempPath = join(__dirname, `temp-realdebrid-${Date.now()}.torrent`);
    const operation = Effect.gen(function* () {
      yield* downloadTorrent(arg.torrent, tempPath);
      const stream = fs.createReadStream(tempPath) as ReadStream;
      return yield* realDebridClient.addTorrent(stream, hostName(arg.host)).pipe(
        Effect.ensuring(Effect.sync(() => stream.destroy()))
      );
    }).pipe(
      Effect.tapError((error) => Effect.sync(() => {
        mainWindow?.webContents?.send('ddl:download-error', { id: Math.random().toString(36).slice(2), error: formatError(error) });
      })),
      Effect.ensuring(Effect.promise(() => fsAsync.rm(tempPath, { force: true })))
    );
    return run(operation, 'Failed to add torrent to Real-Debrid');
  });
}
