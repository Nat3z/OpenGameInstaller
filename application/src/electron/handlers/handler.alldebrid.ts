/**
 * AllDebrid IPC handlers: API key, user info, hosts, add magnet/torrent,
 * readiness check, torrent info, unrestrict link. Uses unique temp paths
 * and cleans up streams on all code paths.
 */
import { ipcMain } from 'electron';
import { sendNotification } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import type { IncomingMessage } from 'http';
import AllDebrid from 'all-debrid-js';
import { ReadStream } from 'original-fs';
import { __dirname } from '../manager/manager.paths.js';
import axios from 'axios';

const CONFIG_PATH = join(__dirname, 'config/option/realdebrid.json');

let allDebridClient = new AllDebrid({
  apiKey: 'UNSET',
});

/**
 * Reads the AllDebrid API key from the realdebrid config file.
 * @returns The API key or null if missing or invalid.
 */
function readAlldebridKey(): string | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const json = JSON.parse(raw);
    return json.alldebridApiKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Registers IPC handlers for AllDebrid: set key, update key, user info, hosts,
 * add magnet/torrent, readiness check, get torrent info, unrestrict link, select torrent.
 */
export default function handler(_mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('all-debrid:set-key', async (_, arg: string) => {
    allDebridClient = new AllDebrid({ apiKey: arg });
    return 'success';
  });

  ipcMain.handle('all-debrid:update-key', async () => {
    const key = readAlldebridKey();
    if (!key) return false;
    allDebridClient = new AllDebrid({ apiKey: key });
    return true;
  });

  ipcMain.handle('all-debrid:get-user-info', async () => {
    return allDebridClient.getUserInfo();
  });

  ipcMain.handle('all-debrid:get-hosts', async () => {
    return allDebridClient.getHosts();
  });

  ipcMain.handle(
    'all-debrid:add-magnet',
    async (_, arg: { url: string; host?: string }) => {
      return allDebridClient.addMagnet(arg.url, arg.host);
    }
  );

  ipcMain.handle('all-debrid:is-torrent-ready', async (_, id: string) => {
    return allDebridClient.isTorrentReady(id);
  });

  ipcMain.handle('all-debrid:get-torrent-info', async (_, id: string) => {
    return allDebridClient.getMagnetFiles(id);
  });

  ipcMain.handle('all-debrid:unrestrict-link', async (_, link: string) => {
    return allDebridClient.unrestrictLink(link);
  });

  ipcMain.handle('all-debrid:select-torrent', async () => {
    return true;
  });

  // Streams (fileStream, responseStream, readStream) are explicitly destroyed on all paths to avoid leaks.
  ipcMain.handle(
    'all-debrid:add-torrent',
    async (_, arg: { torrent: string }) => {
      const tempPath = join(
        __dirname,
        `temp-alldebrid-${Date.now()}-${Math.random().toString(36).slice(2)}.torrent`
      );
      let fileStream: fs.WriteStream | null = null;
      let responseStream: IncomingMessage | null = null;
      const controller = new AbortController();
      const MAX_BYTES = 10 * 1024 * 1024; // 10MB limit for torrent files

      try {
        fileStream = fs.createWriteStream(tempPath);
        const response = await axios({
          method: 'get',
          url: arg.torrent,
          responseType: 'stream',
          timeout: 30000, // Connection timeout
          signal: controller.signal,
        });
        responseStream = response.data as IncomingMessage;
        let bytesRead = 0;

        await new Promise<void>((resolve, reject) => {
          const streamTimeout = setTimeout(() => {
            controller.abort();
            onError(new Error('Torrent download timed out after 60 seconds'));
          }, 60000);

          const onError = (err: Error) => {
            clearTimeout(streamTimeout);
            cleanup();
            reject(err);
          };

          const cleanup = () => {
            if (fileStream) {
              fileStream.destroy();
              fileStream = null;
            }
            if (responseStream) {
              responseStream.destroy();
              responseStream = null;
            }
          };

          if (responseStream && fileStream) {
            responseStream.on('data', (chunk) => {
              bytesRead += chunk.length;
              if (bytesRead > MAX_BYTES) {
                controller.abort();
                onError(
                  new Error(
                    `Torrent file exceeds size limit of ${MAX_BYTES} bytes`
                  )
                );
              }
            });

            responseStream.pipe(fileStream);
            fileStream.on('finish', () => {
              clearTimeout(streamTimeout);
              resolve();
            });
            fileStream.on('error', onError);
            responseStream.on('error', onError);
          } else {
            clearTimeout(streamTimeout);
            reject(new Error('Failed to initialize streams'));
          }
        });

        if (fileStream) {
          fileStream.close();
          fileStream = null;
        }
        if (responseStream) {
          responseStream.destroy();
          responseStream = null;
        }
        const readStream = fs.createReadStream(tempPath) as ReadStream;
        try {
          const data = await allDebridClient.addTorrent(readStream);
          return data;
        } finally {
          readStream.destroy();
        }
      } catch (err) {
        if (fileStream) {
          fileStream.destroy();
          fileStream = null;
        }
        if (responseStream) {
          responseStream.destroy();
          responseStream = null;
        }
        console.error(err);
        sendNotification({
          message: 'Failed to add torrent to AllDebrid',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        return null;
      } finally {
        if (fileStream) {
          fileStream.destroy();
          fileStream = null;
        }
        if (responseStream) {
          responseStream.destroy();
          responseStream = null;
        }
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {
          // ignore
        }
      }
    }
  );
}
