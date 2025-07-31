import axios from 'axios';
import { ipcMain } from 'electron';
import { sendNotification, torrentIntervals } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import { getStoredValue, refreshCached } from '../config-util.js';
import { QBittorrent } from '@ctrl/qbittorrent';
import { readFile } from 'fs/promises';
import { torrent } from '../webtorrent-connect.js';
import { __dirname } from '../paths.js';
import { DOWNLOAD_QUEUE } from '../queue.js';

let qbitClient: QBittorrent | undefined = undefined;

// Store torrent hashes for each download ID to enable pause/resume/abort functionality
const torrentHashes = new Map<string, string>();

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
    console.error(err);
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
  // Debug logging to track paths
  console.log(`[torrent-handler] Processing ${type} download:`, {
    downloadID,
    link: arg.link.substring(0, 100) + (arg.link.length > 100 ? '...' : ''),
    path: arg.path,
    pathLength: arg.path.length,
  });

  // Validate path length to prevent ENAMETOOLONG errors
  const maxPathLength = process.platform === 'win32' ? 260 : 4096;
  if (arg.path.length > maxPathLength) {
    console.error(
      `[torrent-handler] Path too long: ${arg.path.length} characters`
    );
    sendNotification({
      message: `Download path is too long (${arg.path.length} characters). Maximum allowed is ${maxPathLength}.`,
      id: downloadID,
      type: 'error',
    });
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('ddl:download-error', {
        id: downloadID,
        error: `Path too long: ${arg.path.length} characters`,
      });
    }
    finish();
    return null;
  }

  // Validate that the path doesn't contain the magnet/torrent URL
  if (type === 'magnet' && arg.path.includes('magnet:')) {
    console.error(
      `[torrent-handler] Invalid path contains magnet link: ${arg.path.substring(0, 100)}...`
    );
    sendNotification({
      message:
        'Invalid download path detected. The path contains a magnet link instead of a file path.',
      id: downloadID,
      type: 'error',
    });
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('ddl:download-error', {
        id: downloadID,
        error: 'Invalid path: contains magnet link',
      });
    }
    finish();
    return null;
  }

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
    console.error('Download cancelled');
    return null;
  }

  switch (torrentClient) {
    case 'qbittorrent': {
      try {
        qbitClient = await setupQbitClient();

        let torrentHash: string | undefined;

        if (type === 'torrent') {
          const torrentData = await downloadTorrentFile(
            arg.link,
            join(__dirname, 'temp.torrent'),
            arg.path,
            mainWindow,
            downloadID,
            finish
          );
          if (!torrentData) {
            console.error('No torrent data returned');
            return null;
          }
          await qbitClient.addTorrent(torrentData, {
            savepath: arg.path + '.torrent',
          });
          // The QBittorrent library doesn't return the hash directly, so we'll need to find it
          // by monitoring the torrent list for new additions
        } else {
          await qbitClient.addMagnet(arg.link, {
            savepath: arg.path + '.torrent',
          });
          // Similar issue with magnet links
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

        const pauseHandler = async () => {
          if (!isPaused && torrentHash) {
            isPaused = true;
            console.log('QBittorrent download paused:', torrentHash);
            try {
              await qbitClient?.pauseTorrent(torrentHash);
              mainWindow.webContents.send('torrent:download-paused', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download paused',
                id: downloadID,
                type: 'info',
              });
            } catch (error) {
              console.error('Failed to pause torrent:', error);
            }
          }
        };

        const resumeHandler = async () => {
          if (isPaused && torrentHash) {
            isPaused = false;
            console.log('QBittorrent download resumed:', torrentHash);
            try {
              await qbitClient?.resumeTorrent(torrentHash);
              mainWindow.webContents.send('torrent:download-resumed', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download resumed',
                id: downloadID,
                type: 'info',
              });
            } catch (error) {
              console.error('Failed to resume torrent:', error);
            }
          }
        };

        const abortHandler = async () => {
          if (torrentHash) {
            console.log('QBittorrent download aborted:', torrentHash);
            try {
              await qbitClient?.removeTorrent(torrentHash, true);
              torrentHashes.delete(downloadID);
              clearInterval(torrentInterval);
              clearInterval(progressInterval);
              mainWindow.webContents.send('torrent:download-cancelled', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download aborted',
                id: downloadID,
                type: 'info',
              });
              finish();
            } catch (error) {
              console.error('Failed to abort torrent:', error);
            }
          }
        };

        // Remove any existing handlers first
        ipcMain.removeHandler(`torrent:${downloadID}:pause`);
        ipcMain.removeHandler(`torrent:${downloadID}:resume`);
        ipcMain.removeHandler(`torrent:${downloadID}:abort`);

        ipcMain.handle(`torrent:${downloadID}:pause`, pauseHandler);
        ipcMain.handle(`torrent:${downloadID}:resume`, resumeHandler);
        ipcMain.handle(`torrent:${downloadID}:abort`, abortHandler);

        const torrentInterval = setInterval(async () => {
          if (!qbitClient) {
            clearInterval(torrentInterval);
            clearInterval(progressInterval);
            finish();
            return;
          }

          // Find the torrent by save path if we don't have the hash yet
          const torrents = (await qbitClient.getAllData()).torrents;
          let torrent;

          if (!torrentHash) {
            // Try to find the torrent by save path
            torrent = torrents.find(
              (t) =>
                t.savePath === arg.path.replaceAll('/', '\\') ||
                t.savePath === arg.path
            );
            if (torrent) {
              torrentHash = torrent.id;
              torrentHashes.set(downloadID, torrentHash);
              console.log(
                `[torrent-handler] Found torrent hash: ${torrentHash}`
              );
            }
          } else {
            // Find torrent by hash
            torrent = torrents.find((t) => t.id === torrentHash);
          }

          if (!torrent) {
            // If we still can't find the torrent after some time, give up
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

            // Clean up handlers and hash tracking
            ipcMain.removeHandler(`torrent:${downloadID}:pause`);
            ipcMain.removeHandler(`torrent:${downloadID}:resume`);
            ipcMain.removeHandler(`torrent:${downloadID}:abort`);
            torrentHashes.delete(downloadID);

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
        console.error(except);
        return null;
      }
    }
    case 'webtorrent': {
      try {
        // if (await checkFileExists(arg.path, downloadID, mainWindow, finish))
        //   return null;
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
            console.error(err);
            return null;
          });
          if (!torrentData) {
            console.error('No torrent data returned');
            return null;
          }
          // --- Throttled progress reporting setup for webtorrent ---
          let lastProgress = 0;
          let lastDownloadSpeed = 0;
          let lastFileSize = 0;
          let lastRatio = 0;
          let finished = false;
          let progressInterval: NodeJS.Timeout;

          const startProgressReporting = () => {
            progressInterval = setInterval(() => {
              if (!finished && !isPaused) {
                sendProgress(mainWindow, downloadID, {
                  downloadSpeed: lastDownloadSpeed,
                  progress: lastProgress,
                  fileSize: lastFileSize,
                  ratio: lastRatio,
                  queuePosition: 1,
                });
              }
            }, 500);
          };

          const stopProgressReporting = () => {
            if (progressInterval) {
              clearInterval(progressInterval);
            }
          };

          startProgressReporting();
          // --- End throttled setup ---

          // Listen for pause event from frontend
          let isPaused = false;

          // turn torrentData into a buffer
          const torrentBuffer = Buffer.from(torrentData);
          const session = torrent(torrentBuffer, arg.path + '.torrent');
          const block = await session.start(
            (_, speed, progress, length, ratio) => {
              lastDownloadSpeed = speed;
              lastProgress = progress;
              lastFileSize = length;
              lastRatio = ratio;
            },
            () => {
              console.log('Torrent download finished');
              finished = true;
              stopProgressReporting();
              // Send one last progress update at 100%
              sendProgress(mainWindow, downloadID, {
                downloadSpeed: lastDownloadSpeed,
                progress: 1,
                fileSize: lastFileSize,
                ratio: lastRatio,
                queuePosition: 1,
              });
              sendComplete(mainWindow, downloadID);
              // seed the torrent
              session.seed();
              ipcMain.removeHandler(`torrent:${downloadID}:pause`);
              ipcMain.removeHandler(`torrent:${downloadID}:resume`);
              ipcMain.removeHandler(`torrent:${downloadID}:abort`);
              finish();
            }
          );
          ipcMain.handle(`torrent:${downloadID}:pause`, () => {
            if (!isPaused) {
              isPaused = true;
              console.log('WebTorrent download paused');
              stopProgressReporting();
              mainWindow.webContents.send('torrent:download-paused', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download paused',
                id: downloadID,
                type: 'info',
              });
              // Use the true pause method from webtorrent-connect
              block.pause();
            }
          });

          ipcMain.handle(`torrent:${downloadID}:resume`, () => {
            if (isPaused) {
              isPaused = false;
              console.log('WebTorrent download resumed');
              startProgressReporting();
              mainWindow.webContents.send('torrent:download-resumed', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download resumed',
                id: downloadID,
                type: 'info',
              });
              // Use the true resume method from webtorrent-connect
              block.resume();
            }
          });

          ipcMain.handleOnce(`torrent:${downloadID}:abort`, () => {
            stopProgressReporting();
            block.destroy();
          });
        } else {
          // --- Throttled progress reporting setup for webtorrent magnet ---
          let lastProgress = 0;
          let lastDownloadSpeed = 0;
          let lastFileSize = 0;
          let lastRatio = 0;
          let finished = false;
          let progressInterval: NodeJS.Timeout;

          const startProgressReporting = () => {
            progressInterval = setInterval(() => {
              if (!finished && !isPaused) {
                sendProgress(mainWindow, downloadID, {
                  downloadSpeed: lastDownloadSpeed,
                  progress: lastProgress,
                  fileSize: lastFileSize,
                  ratio: lastRatio,
                  queuePosition: 1,
                });
              }
            }, 500);
          };

          const stopProgressReporting = () => {
            if (progressInterval) {
              clearInterval(progressInterval);
            }
          };

          startProgressReporting();
          // --- End throttled setup ---

          // Listen for pause event from frontend
          let isPaused = false;

          const session = torrent(arg.link, arg.path + '.torrent');
          const block = await session.start(
            (_, speed, progress, length, ratio) => {
              lastDownloadSpeed = speed;
              lastProgress = progress;
              lastFileSize = length;
              lastRatio = ratio;
            },
            async () => {
              console.log('Torrent download finished');
              finished = true;
              stopProgressReporting();
              // Send one last progress update at 100%
              sendProgress(mainWindow, downloadID, {
                downloadSpeed: lastDownloadSpeed,
                progress: 1,
                fileSize: lastFileSize,
                ratio: lastRatio,
              });
              sendComplete(mainWindow, downloadID);
              // seed the torrent
              session.seed();

              // remove handlers
              ipcMain.removeHandler(`torrent:${downloadID}:pause`);
              ipcMain.removeHandler(`torrent:${downloadID}:resume`);
              ipcMain.removeHandler(`torrent:${downloadID}:abort`);
              finish();
            }
          );

          // Update handlers to work with the block
          ipcMain.removeHandler(`torrent:${downloadID}:pause`);
          ipcMain.removeHandler(`torrent:${downloadID}:resume`);

          ipcMain.handle(`torrent:${downloadID}:pause`, () => {
            if (!isPaused) {
              isPaused = true;
              console.log('WebTorrent download paused');
              stopProgressReporting();
              mainWindow.webContents.send('torrent:download-paused', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download paused',
                id: downloadID,
                type: 'info',
              });
              // Use the true pause method from webtorrent-connect
              block.pause();
            }
          });
          ipcMain.handle(`torrent:${downloadID}:resume`, () => {
            if (isPaused) {
              isPaused = false;
              console.log('WebTorrent download resumed');
              startProgressReporting();
              mainWindow.webContents.send('torrent:download-resumed', {
                id: downloadID,
              });
              sendNotification({
                message: 'Torrent download resumed',
                id: downloadID,
                type: 'info',
              });
              // Use the true resume method from webtorrent-connect
              block.resume();
            }
          });
          ipcMain.handle(`torrent:${downloadID}:abort`, () => {
            stopProgressReporting();
            block.destroy();
          });
        }
        return downloadID;
      } catch (except) {
        sendNotification({
          message: 'Failed to download torrent.',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        console.error(except);
        finish();
        return null;
      }
    }
  }
  console.error('No torrent client found');
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
