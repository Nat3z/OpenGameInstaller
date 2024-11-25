import axios from "axios";
import { ipcMain } from "electron";
import { sendNotification, torrentIntervals, __dirname } from "../main.js";
import { join } from "path";
import * as fs from "fs";
import { getStoredValue, refreshCached } from "../config-util.js";
import { QBittorrent } from "@ctrl/qbittorrent";
import { readFile } from "fs/promises";
import { addTorrent } from "../webtorrent-connect.js";

let qbitClient: QBittorrent | undefined = undefined;

export default function handler(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('torrent:download-torrent', async (_, arg: { link: string, path: string }) => {
    await refreshCached('general');
    const torrentClient: string = await getStoredValue('general', 'torrentClient') ?? 'webtorrent';

    switch (torrentClient) {
      case 'qbittorrent': {
        try {
          await refreshCached('qbittorrent');
          qbitClient = new QBittorrent({
            baseUrl: ((await getStoredValue('qbittorrent', 'qbitHost')) ?? 'http://127.0.0.1') + ":" + ((await getStoredValue('qbittorrent', 'qbitPort')) ?? '8080'),
            username: (await getStoredValue('qbittorrent', 'qbitUsername')) ?? 'admin',
            password: (await getStoredValue('qbittorrent', 'qbitPassword')) ?? ''
          })
          if (fs.existsSync(arg.path + '.torrent')) {
            sendNotification({
              message: 'File at path already exists. Please delete the file and try again.',
              id: Math.random().toString(36).substring(7),
              type: 'error'
            });
            if (mainWindow && mainWindow.webContents)
              mainWindow.webContents.send('ddl:download-error', { id: Math.random().toString(36).substring(7), error: 'File at path already exists. Please delete the file and try again.' });
            return null;
          }
          const downloadID = Math.random().toString(36).substring(7);
          const torrentData = await new Promise<Buffer>((resolve, reject) => {
            axios({
              method: 'get',
              url: arg.link,
              responseType: 'stream'
            }).then(response => {
              const fileStream = fs.createWriteStream(join(__dirname, 'temp.torrent'));
              response.data.pipe(fileStream);

              fileStream.on('finish', async () => {
                console.log('Download complete!!');
                fileStream.close();
                resolve(await readFile(join(__dirname, 'temp.torrent')));
              });

              fileStream.on('error', (err) => {
                console.error(err);
                fileStream.close();
                fs.unlinkSync(arg.path);
                reject();
              });
            });
          }).catch(err => {
            if (!mainWindow || !mainWindow.webContents) {
              console.error("Seems like the window is closed. Cannot send error message to renderer.")
              return
            }
            console.error(err);
            mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
            sendNotification({
              message: 'Download failed for ' + arg.path,
              id: downloadID,
              type: 'error'
            });
          });

          if (!torrentData) {
            return null;
          }
          await qbitClient.addTorrent(torrentData, {
            savepath: arg.path + '.torrent'
          })

          arg.path = arg.path + '.torrent';
          console.log("[torrent] Checking for torrent at path: " + arg.path)
          let alreadyNotified = false;
          const torrentInterval = setInterval(async () => {
            if (!qbitClient) {
              clearInterval(torrentInterval);
              return;
            }
            const torrent = (await qbitClient.getAllData()).torrents.find(torrent => torrent.savePath === arg.path.replaceAll("/", "\\"));
            if (!torrent) {
              clearInterval(torrentInterval);
              console.error('Torrent not found in qBitTorrent...');
              return;
            }

            const progress = torrent.progress;
            const downloadSpeed = torrent.downloadSpeed;
            const fileSize = torrent.totalSize;
            const ratio = torrent.totalUploaded / torrent.totalDownloaded;
            if (!mainWindow || !mainWindow.webContents) {
              console.error("Seems like the window is closed. Cannot send progress message to renderer.")
              return
            }
            mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed, progress, fileSize, ratio });
            if (torrent.isCompleted && !alreadyNotified) {
              mainWindow.webContents.send('torrent:download-complete', { id: downloadID });
              alreadyNotified = true;
              console.log('Torrent download finished');
            }
          }, 250);
          torrentIntervals.push(torrentInterval);
          return downloadID;
        } catch (except) {
          console.error(except);
          sendNotification({
            message: "Failed to download torrent. Check if qBitTorrent is running.",
            id: Math.random().toString(36).substring(7),
            type: 'error'
          });
          return null;
        }
        break;
      }
      case 'webtorrent': {
        try {
          const fileStream = fs.createWriteStream(join(__dirname, 'temp.torrent'));
          const downloadID = Math.random().toString(36).substring(7);
          const torrentData = await new Promise<Uint8Array>((resolve, reject) => {
            axios({
              method: 'get',
              url: arg.link,
              responseType: 'stream'
            }).then(response => {
              response.data.pipe(fileStream);

              fileStream.on('finish', () => {
                console.log('Download complete!!');
                fileStream.close();
                resolve(fs.readFileSync(join(__dirname, 'temp.torrent')));
              });

              fileStream.on('error', (err) => {
                console.error(err);
                fileStream.close();
                fs.unlinkSync(arg.path);
                reject();
              });
            });
          }).catch(err => {
            if (!mainWindow || !mainWindow.webContents) {
              console.error("Seems like the window is closed. Cannot send error message to renderer.")
              return
            }
            console.error(err);
            mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
            fileStream.close();
            fs.unlinkSync(arg.path);
            sendNotification({
              message: 'Download failed for ' + arg.path,
              id: downloadID,
              type: 'error'
            });
          });
          if (!torrentData) {
            return null;
          }

          if (fs.existsSync(arg.path + '.torrent')) {
            sendNotification({
              message: 'File at path already exists. Please delete the file and try again.',
              id: downloadID,
              type: 'error'
            });
            if (mainWindow && mainWindow.webContents)
              mainWindow.webContents.send('ddl:download-error', { id: Math.random().toString(36).substring(7), error: 'File at path already exists. Please delete the file and try again.' });
            return null;
          }

          addTorrent(torrentData, arg.path + '.torrent',
            (_, speed, progress, length, ratio) => {
              if (!mainWindow || !mainWindow.webContents) {
                console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                return
              }
              mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed: speed, progress, fileSize: length, ratio });
            },
            () => {
              if (!mainWindow || !mainWindow.webContents) {
                console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                return
              }
              mainWindow.webContents.send('torrent:download-complete', { id: downloadID });
              console.log('Torrent download finished');
            }
          );

          return downloadID;


        } catch (except) {
          console.error(except);
          sendNotification({
            message: "Failed to download torrent.",
            id: Math.random().toString(36).substring(7),
            type: 'error'
          });
          return null;
        }
        break;
      }
    }
    return null;
  });

  ipcMain.handle('torrent:download-magnet', async (_, arg: { link: string, path: string }) => {
    await refreshCached('general');
    const torrentClient: string = await getStoredValue('general', 'torrentClient') ?? 'webtorrent';

    switch (torrentClient) {
      case 'qbittorrent': {
        try {
          await refreshCached('qbittorrent');
          qbitClient = new QBittorrent({
            baseUrl: ((await getStoredValue('qbittorrent', 'qbitHost')) ?? 'http://127.0.0.1') + ":" + ((await getStoredValue('qbittorrent', 'qbitPort')) ?? '8080'),
            username: (await getStoredValue('qbittorrent', 'qbitUsername')) ?? 'admin',
            password: (await getStoredValue('qbittorrent', 'qbitPassword')) ?? ''
          })

          if (fs.existsSync(arg.path + '.torrent')) {
            sendNotification({
              message: 'File at path already exists. Please delete the file and try again.',
              id: Math.random().toString(36).substring(7),
              type: 'error'
            });
            return null;
          }

          const downloadID = Math.random().toString(36).substring(7);
          await qbitClient.addMagnet(arg.link, {
            savepath: arg.path + '.torrent'
          })
          let alreadyNotified = false;
          arg.path = arg.path + '.torrent';
          console.log("[magnet] Checking for torrent at path: " + arg.path)
          const torrentInterval = setInterval(async () => {
            if (!qbitClient) {
              clearInterval(torrentInterval);
              return;
            }

            const torrent = (await qbitClient.getAllData()).torrents.find(torrent => torrent.savePath === arg.path.replaceAll("/", "\\"));
            if (!torrent) {
              clearInterval(torrentInterval);
              console.error('Torrent not found in qBitTorrent...');
              return;
            }

            const progress = torrent.progress;
            const downloadSpeed = torrent.downloadSpeed;
            const fileSize = torrent.totalSize;
            const ratio = torrent.totalUploaded / torrent.totalDownloaded;
            if (!mainWindow || !mainWindow.webContents) {
              console.error("Seems like the window is closed. Cannot send progress message to renderer.")
              return
            }
            mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed, progress, fileSize, ratio });
            if (torrent.isCompleted && !alreadyNotified) {
              mainWindow.webContents.send('torrent:download-complete', { id: downloadID });
              alreadyNotified = true;
              console.log('Torrent download finished');
            }
          }, 250);
          torrentIntervals.push(torrentInterval);
          return downloadID;
        } catch (except) {
          console.error(except);
          sendNotification({
            message: "Failed to download torrent. Check if qBitTorrent is running.",
            id: Math.random().toString(36).substring(7),
            type: 'error'
          });
          return null;
        }
        break;
      }
      case 'webtorrent': {
        try {
          const downloadID = Math.random().toString(36).substring(7);

          if (fs.existsSync(arg.path + '.torrent')) {
            sendNotification({
              message: 'File at path already exists. Please delete the file and try again.',
              id: downloadID,
              type: 'error'
            });
            if (mainWindow && mainWindow.webContents)
              mainWindow.webContents.send('ddl:download-error', { id: Math.random().toString(36).substring(7), error: 'File at path already exists. Please delete the file and try again.' });
            return null;
          }

          addTorrent(arg.link, arg.path + '.torrent',
            (_, speed, progress, length, ratio) => {
              if (!mainWindow || !mainWindow.webContents) {
                console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                return
              }
              mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed: speed, progress, fileSize: length, ratio });
            },
            () => {
              if (!mainWindow || !mainWindow.webContents) {
                console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                return
              }
              mainWindow.webContents.send('torrent:download-complete', { id: downloadID });
              console.log('Torrent download finished');
            }
          );

          return downloadID;


        } catch (except) {
          console.error(except);
          sendNotification({
            message: "Failed to download torrent.",
            id: Math.random().toString(36).substring(7),
            type: 'error'
          });
          return null;
        }
        break;
      }
    }
    return null;
  });
}
