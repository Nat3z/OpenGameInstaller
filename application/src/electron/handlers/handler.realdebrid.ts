import axios from 'axios';
import { ipcMain } from 'electron';
import { sendNotification } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import RealDebrid from 'real-debrid-js';
import { ReadStream } from 'original-fs';
import { __dirname } from '../manager/manager.paths.js';

let realDebridClient = new RealDebrid({
  apiKey: 'UNSET',
});
export default function handler(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('real-debrid:set-key', async (_, arg) => {
    realDebridClient = new RealDebrid({
      apiKey: arg,
    });
    return 'success';
  });

  ipcMain.handle('real-debrid:update-key', async () => {
    if (!fs.existsSync(join(__dirname, 'config/option/realdebrid.json'))) {
      return false;
    }
    const rdInfo = fs.readFileSync(
      join(__dirname, 'config/option/realdebrid.json'),
      'utf-8'
    );
    const rdInfoJson = JSON.parse(rdInfo);
    realDebridClient = new RealDebrid({
      apiKey: rdInfoJson.debridApiKey,
    });
    return true;
  });

  ipcMain.handle('real-debrid:add-magnet', async (_, arg) => {
    const torrentAdded = await realDebridClient.addMagnet(arg.url, arg.host);
    return torrentAdded;
  });

  // real-debrid binding
  ipcMain.handle('real-debrid:get-user-info', async () => {
    const userInfo = await realDebridClient.getUserInfo();
    return userInfo;
  });

  ipcMain.handle('real-debrid:unrestrict-link', async (_, arg) => {
    const unrestrictedLink = await realDebridClient.unrestrictLink(arg);
    return unrestrictedLink;
  });

  ipcMain.handle('real-debrid:get-hosts', async () => {
    const hosts = await realDebridClient.getHosts();
    return hosts;
  });

  ipcMain.handle('real-debrid:get-torrent-info', async (_, arg) => {
    const torrents = await realDebridClient.getTorrentInfo(arg);
    return torrents;
  });

  ipcMain.handle('real-debrid:is-torrent-ready', async (_, arg) => {
    const torrentReady = await realDebridClient.isTorrentReady(arg);
    return torrentReady;
  });

  ipcMain.handle('real-debrid:select-torrent', async (_, arg) => {
    const selected = await realDebridClient.selectTorrents(arg);
    return selected;
  });
  ipcMain.handle('real-debrid:add-torrent', async (_, arg) => {
    // arg.url is a link to the download, we need to get the file
    // and send it to the real-debrid API
    console.log(arg);
    const tempPath = join(
      __dirname,
      `temp-realdebrid-${Date.now()}-${Math.random().toString(36).slice(2)}.torrent`
    );
    let fileStream: fs.WriteStream | null = null;
    const downloadID = Math.random().toString(36).substring(7);

    try {
      fileStream = fs.createWriteStream(tempPath);
      const torrentData = await new Promise<ReadStream>((resolve, reject) => {
        axios({
          method: 'get',
          url: arg.torrent,
          responseType: 'stream',
        })
          .then((response) => {
            response.data.pipe(fileStream!);

            fileStream!.on('finish', () => {
              console.log('Download complete!!');
              fileStream!.close();
              resolve(fs.createReadStream(tempPath));
            });

            fileStream!.on('error', (err) => {
              console.error(err);
              if (fileStream && !fileStream.destroyed) {
                fileStream.close();
              }
              reject(err);
            });
          })
          .catch((err) => {
            if (fileStream && !fileStream.destroyed) {
              fileStream.close();
            }
            reject(err);
          });
      })
        .catch((err) => {
          if (!mainWindow || !mainWindow.webContents) {
            console.error(
              'Seems like the window is closed. Cannot send error message to renderer.'
            );
            return;
          }
          console.error(err);
          mainWindow.webContents.send('ddl:download-error', {
            id: downloadID,
            error: err,
          });
          if (fileStream && !fileStream.destroyed) {
            fileStream.close();
          }
          sendNotification({
            message: 'Download failed for torrent',
            id: downloadID,
            type: 'error',
          });
        })
        .finally(() => {
          // Always cleanup temp file
          try {
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
            }
          } catch (cleanupErr) {
            console.error('Error cleaning up temp file:', cleanupErr);
          }
        });

      if (!torrentData) {
        return null;
      }
      console.log('Downloaded torrent! Now adding to readDebrid');

      const data = await realDebridClient.addTorrent(torrentData as ReadStream);
      console.log('Added torrent to real-debrid!');
      return data;
    } catch (except) {
      console.error(except);
      sendNotification({
        message: 'Failed to add torrent to Real-Debrid',
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
      return null;
    } finally {
      // Cleanup temp file
      try {
        if (fileStream && !fileStream.destroyed) {
          fileStream.close();
        }
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (cleanupErr) {
        console.error('Error cleaning up temp file:', cleanupErr);
      }
    }
  });
}
