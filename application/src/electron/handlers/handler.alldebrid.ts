import { ipcMain } from 'electron';
import { sendNotification } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import AllDebrid from 'all-debrid-js';
import { ReadStream } from 'original-fs';
import { __dirname } from '../manager/manager.paths.js';
import axios from 'axios';

const CONFIG_PATH = join(__dirname, 'config/option/realdebrid.json');
const TEMP_TORRENT_PATH = join(__dirname, 'temp-alldebrid.torrent');

let allDebridClient = new AllDebrid({
  apiKey: 'UNSET',
});

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

  ipcMain.handle('all-debrid:add-magnet', async (_, arg: { url: string; host?: unknown }) => {
    return allDebridClient.addMagnet(arg.url, arg.host as string | undefined);
  });

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

  ipcMain.handle('all-debrid:add-torrent', async (_, arg: { torrent: string }) => {
    const tempPath = TEMP_TORRENT_PATH;
    const fileStream = fs.createWriteStream(tempPath);
    try {
      await new Promise<void>((resolve, reject) => {
        axios({
          method: 'get',
          url: arg.torrent,
          responseType: 'stream',
        })
          .then((response) => {
            response.data.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve();
            });
            fileStream.on('error', (err: Error) => {
              fileStream.close();
              reject(err);
            });
          })
          .catch(reject);
      });

      const readStream = fs.createReadStream(tempPath) as ReadStream;
      const data = await allDebridClient.addTorrent(readStream);
      return data;
    } catch (err) {
      console.error(err);
      sendNotification({
        message: 'Failed to add torrent to AllDebrid',
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
      return null;
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  });
}
