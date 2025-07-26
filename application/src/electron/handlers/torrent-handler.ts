import axios from 'axios';
import { ipcMain } from 'electron';
import { sendNotification, torrentIntervals } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import { getStoredValue, refreshCached } from '../config-util.js';
import { QBittorrent } from '@ctrl/qbittorrent';
import { readFile } from 'fs/promises';
import { addTorrent } from '../webtorrent-connect.js';
import { __dirname } from '../paths.js';
import { DOWNLOAD_QUEUE } from '../queue.js';

let qbitClient: QBittorrent | undefined = undefined;

// --- Helper Functions ---
async function checkFileExists(
  path: string,
  downloadID: string,
  mainWindow: Electron.BrowserWindow,
  finish: () => void
) {
  if (fs.existsSync(path + '.torrent')) {
    sendNotification({
      message:
        'File at path already exists. Please delete the file and try again.',
      id: downloadID,
      type: 'error',
    });
    if (mainWindow && mainWindow.webContents)
      mainWindow.webContents.send('ddl:download-error', {
        id: Math.random().toString(36).substring(7),
        error:
          'File at path already exists. Please delete the file and try again.',
      });
    finish();
    return true;
  }
  return false;
}

function sendProgress(
  mainWindow: Electron.BrowserWindow,
  id: string,
  data: any
) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('torrent:download-progress', { id, ...data });
  }
}

function sendComplete(mainWindow: Electron.BrowserWindow, id: string) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('torrent:download-complete', { id });
  }
}

function sendError(
  mainWindow: Electron.BrowserWindow,
  id: string,
  error: any,
  finish: () => void
) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('ddl:download-error', { id, error });
  }
  finish();
}

async function setupQbitClient() {
  await refreshCached('qbittorrent');
  return new QBittorrent({
    baseUrl:
      ((await getStoredValue('qbittorrent', 'qbitHost')) ??
        'http://127.0.0.1') +
      ':' +
      ((await getStoredValue('qbittorrent', 'qbitPort')) ?? '8080'),
    username: (await getStoredValue('qbittorrent', 'qbitUsername')) ?? 'admin',
    password: (await getStoredValue('qbittorrent', 'qbitPassword')) ?? '',
  });
}

async function downloadTorrentFile(
  link: string,
  tempPath: string,
  argPath: string,
  mainWindow: Electron.BrowserWindow,
  downloadID: string,
  finish: () => void
) {
  return await new Promise<Buffer>((resolve, reject) => {
    axios({ method: 'get', url: link, responseType: 'stream' }).then(
      (response) => {
        const fileStream = fs.createWriteStream(tempPath);
        response.data.pipe(fileStream);
        fileStream.on('finish', async () => {
          fileStream.close();
          resolve(await readFile(tempPath));
        });
        fileStream.on('error', (err) => {
          fileStream.close();
          fs.unlinkSync(argPath);
          reject(err);
        });
      }
    );
  }).catch((err) => {
    if (!mainWindow || !mainWindow.webContents) {
      return;
    }
    mainWindow.webContents.send('ddl:download-error', {
      id: downloadID,
      error: err,
    });
    sendNotification({
      message: 'Download failed for ' + argPath,
      id: downloadID,
      type: 'error',
    });
    finish();
    return null;
  });
}

async function handleTorrentDownload({
  type,
  arg,
  mainWindow,
  downloadID,
  wait,
  finish,
  cancelHandler,
}: {
  type: 'torrent' | 'magnet';
  arg: { link: string; path: string };
  mainWindow: Electron.BrowserWindow;
  downloadID: string;
  wait: (cb: (newPos: number) => void) => Promise<'cancelled' | 'fulfilled'>;
  finish: () => void;
  cancelHandler: (cancel: (handle: () => void) => void) => void;
}) {
  await refreshCached('general');
  const torrentClient: string =
    (await getStoredValue('general', 'torrentClient')) ?? 'webtorrent';
  cancelHandler((cancel) => {
    ipcMain.handleOnce(`queue:${downloadID}:cancel`, (_) => {
      cancel();
    });
  });
  const result = await wait((newPos) => {
    sendProgress(mainWindow, downloadID, { queuePosition: newPos });
  });

  ipcMain.removeHandler(`queue:${downloadID}:cancel`);

  if (result === 'cancelled') {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('torrent:download-cancelled', {
        id: downloadID,
      });
    }
    return null;
  }

  switch (torrentClient) {
    case 'qbittorrent': {
      try {
        qbitClient = await setupQbitClient();
        if (await checkFileExists(arg.path, downloadID, mainWindow, finish))
          return null;
        if (type === 'torrent') {
          const torrentData = await downloadTorrentFile(
            arg.link,
            join(__dirname, 'temp.torrent'),
            arg.path,
            mainWindow,
            downloadID,
            finish
          );
          if (!torrentData) return null;
          await qbitClient.addTorrent(torrentData, {
            savepath: arg.path + '.torrent',
          });
        } else {
          await qbitClient.addMagnet(arg.link, {
            savepath: arg.path + '.torrent',
          });
        }
        let alreadyNotified = false;
        arg.path = arg.path + '.torrent';
        // --- Throttled progress reporting setup for qbittorrent ---
        let lastProgress = 0;
        let lastDownloadSpeed = 0;
        let lastFileSize = 0;
        let lastRatio = 0;
        let finished = false;
        const progressInterval = setInterval(() => {
          if (!finished) {
            sendProgress(mainWindow, downloadID, {
              downloadSpeed: lastDownloadSpeed,
              progress: lastProgress,
              fileSize: lastFileSize,
              ratio: lastRatio,
              queuePosition: 1,
            });
          }
        }, 500);
        // --- End throttled setup ---
        // Listen for pause event from frontend
        let isPaused = false;
        
        ipcMain.handleOnce(`torrent:${downloadID}:pause`, () => {
          if (!isPaused) {
            isPaused = true;
            console.log('Torrent download paused');
            mainWindow.webContents.send('torrent:download-paused', {
              id: downloadID,
            });
            sendNotification({
              message: 'Torrent download paused',
              id: downloadID,
              type: 'info',
            });
          }
        });

        // Listen for resume event from frontend
        ipcMain.handleOnce(`torrent:${downloadID}:resume`, () => {
          if (isPaused) {
            isPaused = false;
            console.log('Torrent download resumed');
            mainWindow.webContents.send('torrent:download-resumed', {
              id: downloadID,
            });
            sendNotification({
              message: 'Torrent download resumed',
              id: downloadID,
              type: 'info',
            });
          }
        });

        const torrentInterval = setInterval(async () => {
          if (!qbitClient) {
            clearInterval(torrentInterval);
            clearInterval(progressInterval);
            finish();
            return;
          }
          const torrent = (await qbitClient.getAllData()).torrents.find(
            (torrent) => torrent.savePath === arg.path.replaceAll('/', '\\')
          );
          if (!torrent) {
            clearInterval(torrentInterval);
            clearInterval(progressInterval);
            finish();
            return;
          }
          // Just update the last* vars, don't send directly
          lastDownloadSpeed = torrent.downloadSpeed;
          lastProgress = torrent.progress;
          lastFileSize = torrent.totalSize;
          lastRatio = torrent.totalUploaded / torrent.totalDownloaded;
          if (torrent.isCompleted && !alreadyNotified) {
            finished = true;
            clearInterval(torrentInterval);
            clearInterval(progressInterval);
            // Send one last progress update at 100%
            sendProgress(mainWindow, downloadID, {
              downloadSpeed: lastDownloadSpeed,
              progress: 1,
              fileSize: lastFileSize,
              ratio: lastRatio,
              queuePosition: 1,
            });
            sendComplete(mainWindow, downloadID);
            alreadyNotified = true;
            finish();
          }
        }, 250);
        torrentIntervals.push(torrentInterval);
        return downloadID;
      } catch (except) {
        sendNotification({
          message:
            'Failed to download torrent. Check if qBitTorrent is running.',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        finish();
        return null;
      }
    }
    case 'webtorrent': {
      try {
        if (await checkFileExists(arg.path, downloadID, mainWindow, finish))
          return null;
        if (type === 'torrent') {
          const fileStream = fs.createWriteStream(
            join(__dirname, 'temp.torrent')
          );
          const torrentData = await new Promise<Uint8Array>(
            (resolve, reject) => {
              axios({
                method: 'get',
                url: arg.link,
                responseType: 'stream',
              }).then((response) => {
                response.data.pipe(fileStream);
                fileStream.on('finish', () => {
                  fileStream.close();
                  resolve(fs.readFileSync(join(__dirname, 'temp.torrent')));
                });
                fileStream.on('error', (err) => {
                  fileStream.close();
                  fs.unlinkSync(arg.path);
                  reject(err);
                });
              });
            }
          ).catch((err) => {
            sendError(mainWindow, downloadID, err, finish);
            fileStream.close();
            fs.unlinkSync(arg.path);
            sendNotification({
              message: 'Download failed for ' + arg.path,
              id: downloadID,
              type: 'error',
            });
            return null;
          });
          if (!torrentData) return null;
          // --- Throttled progress reporting setup for webtorrent ---
          let lastProgress = 0;
          let lastDownloadSpeed = 0;
          let lastFileSize = 0;
          let lastRatio = 0;
          let finished = false;
          const progressInterval = setInterval(() => {
            if (!finished) {
              sendProgress(mainWindow, downloadID, {
                downloadSpeed: lastDownloadSpeed,
                progress: lastProgress,
                fileSize: lastFileSize,
                ratio: lastRatio,
                queuePosition: 1,
              });
            }
          }, 500);
          // --- End throttled setup ---

          // Listen for pause event from frontend
          let isPaused = false;
          
          ipcMain.handleOnce(`torrent:${downloadID}:pause`, () => {
            if (!isPaused) {
              isPaused = true;
              console.log('WebTorrent download paused');
              mainWindow.webContents.send('torrent:download-paused', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download paused',
                id: downloadID,
                type: 'info',
              });
            }
          });

          // Listen for resume event from frontend
          ipcMain.handleOnce(`torrent:${downloadID}:resume`, () => {
            if (isPaused) {
              isPaused = false;
              console.log('WebTorrent download resumed');
              mainWindow.webContents.send('torrent:download-resumed', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download resumed',
                id: downloadID,
                type: 'info',
              });
            }
          });
          addTorrent(
            torrentData,
            arg.path + '.torrent',
            (_, speed, progress, length, ratio) => {
              lastDownloadSpeed = speed;
              lastProgress = progress;
              lastFileSize = length;
              lastRatio = ratio;
            },
            () => {
              finished = true;
              clearInterval(progressInterval);
              // Send one last progress update at 100%
              sendProgress(mainWindow, downloadID, {
                downloadSpeed: lastDownloadSpeed,
                progress: 1,
                fileSize: lastFileSize,
                ratio: lastRatio,
                queuePosition: 1,
              });
              sendComplete(mainWindow, downloadID);
              finish();
            }
          );
        } else {
          // --- Throttled progress reporting setup for webtorrent magnet ---
          let lastProgress = 0;
          let lastDownloadSpeed = 0;
          let lastFileSize = 0;
          let lastRatio = 0;
          let finished = false;
          const progressInterval = setInterval(() => {
            if (!finished) {
              sendProgress(mainWindow, downloadID, {
                downloadSpeed: lastDownloadSpeed,
                progress: lastProgress,
                fileSize: lastFileSize,
                ratio: lastRatio,
                queuePosition: 1,
              });
            }
          }, 500);
          // --- End throttled setup ---

          // Listen for pause event from frontend
          let isPaused = false;
          
          ipcMain.handleOnce(`torrent:${downloadID}:pause`, () => {
            if (!isPaused) {
              isPaused = true;
              console.log('WebTorrent magnet download paused');
              mainWindow.webContents.send('torrent:download-paused', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download paused',
                id: downloadID,
                type: 'info',
              });
            }
          });

          // Listen for resume event from frontend
          ipcMain.handleOnce(`torrent:${downloadID}:resume`, () => {
            if (isPaused) {
              isPaused = false;
              console.log('WebTorrent magnet download resumed');
              mainWindow.webContents.send('torrent:download-resumed', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download resumed',
                id: downloadID,
                type: 'info',
              });
            }
          });
          addTorrent(
            arg.link,
            arg.path + '.torrent',
            (_, speed, progress, length, ratio) => {
              lastDownloadSpeed = speed;
              lastProgress = progress;
              lastFileSize = length;
              lastRatio = ratio;
            },
            () => {
              finished = true;
              clearInterval(progressInterval);
              // Send one last progress update at 100%
              sendProgress(mainWindow, downloadID, {
                downloadSpeed: lastDownloadSpeed,
                progress: 1,
                fileSize: lastFileSize,
                ratio: lastRatio,
              });
              sendComplete(mainWindow, downloadID);
              finish();
            }
          );
        }
        return downloadID;
      } catch (except) {
        sendNotification({
          message: 'Failed to download torrent.',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        finish();
        return null;
      }
    }
  }
  return null;
}

// --- Main Handler ---
export default function handler(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle(
    'torrent:download-torrent',
    async (_, arg: { link: string; path: string }) => {
      const downloadID = Math.random().toString(36).substring(7);
      const { wait, finish, cancelHandler } = DOWNLOAD_QUEUE.enqueue(
        downloadID,
        {
          type: 'torrent',
        }
      );

      // -- handle this asynchronously --
      handleTorrentDownload({
        type: 'torrent',
        arg,
        mainWindow,
        downloadID,
        wait,
        finish,
        cancelHandler,
      });
      return downloadID;
    }
  );

  ipcMain.handle(
    'torrent:download-magnet',
    async (_, arg: { link: string; path: string }) => {
      const downloadID = Math.random().toString(36).substring(7);
      const { wait, finish, cancelHandler } = DOWNLOAD_QUEUE.enqueue(
        downloadID,
        {
          type: 'torrent',
        }
      );
      return handleTorrentDownload({
        type: 'magnet',
        arg,
        mainWindow,
        downloadID,
        wait,
        finish,
        cancelHandler,
      });
    }
  );
}
