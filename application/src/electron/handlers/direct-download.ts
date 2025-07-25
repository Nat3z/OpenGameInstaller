import { ipcMain } from 'electron';
import * as fs from 'fs';
import { sendNotification } from '../main.js';
import axios from 'axios';
import { __dirname } from '../paths.js';
import { DOWNLOAD_QUEUE } from '../queue.js';

// Main handler function to register the direct download IPC handler
export default function handler(mainWindow: Electron.BrowserWindow) {
  // Register IPC handler for 'ddl:download' events
  ipcMain.handle(
    'ddl:download',
    // args: array of { link: string; path: string }
    async (_, args: { link: string; path: string }[]) => {
      // Generate a unique ID for this download batch
      const downloadID = Math.random().toString(36).substring(7);
      // Enqueue the download in the global DOWNLOAD_QUEUE
      const { initialPosition, wait, finish, cancelHandler } =
        DOWNLOAD_QUEUE.enqueue(downloadID, {
          type: 'direct',
        });
      // Begin download process for each file in args
      new Promise<void>(async (resolve, reject) => {
        console.log(`[${downloadID}] Initial position: ${initialPosition}`);
        cancelHandler((cancel) => {
          ipcMain.handleOnce(`queue:${downloadID}:cancel`, (_) => {
            cancel();
          });
        });
        // Wait for our turn in the queue, reporting position to frontend
        const result = await wait((queuePosition) => {
          if (mainWindow && mainWindow.webContents) {
            console.log(
              `[${downloadID}] Updated Queue position: ${queuePosition}`
            );
            mainWindow.webContents.send('ddl:download-progress', {
              id: downloadID,
              queuePosition,
            });
          }
        });

        ipcMain.removeHandler(`queue:${downloadID}:cancel`);

        if (result === 'cancelled') {
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('ddl:download-cancelled', {
              id: downloadID,
            });
          }
          reject();
          return;
        }
        let parts = 0;
        for (const arg of args) {
          parts++;
          // Check if file already exists at destination
          if (fs.existsSync(arg.path)) {
            sendNotification({
              message:
                'File at path already exists. Please delete the file and try again.',
              id: downloadID,
              type: 'error',
            });
            if (mainWindow && mainWindow.webContents)
              mainWindow.webContents.send('ddl:download-error', {
                id: downloadID,
                error:
                  'File at path already exists. Please delete the file and try again.',
              });
            finish();
            return reject();
          }
          // Ensure destination directory exists
          fs.mkdirSync(arg.path.split('/').slice(0, -1).join('/'), {
            recursive: true,
          });
          // Create a write stream for the file
          let fileStream = fs.createWriteStream(arg.path);

          // Log start of download
          console.log('Starting download...');

          // Handle file stream errors
          fileStream.on('error', (err) => {
            console.error(err);
            if (mainWindow && mainWindow.webContents)
              mainWindow.webContents.send('ddl:download-error', {
                id: downloadID,
                error: err,
              });
            fileStream.close();
            finish();
            reject();
          });
          console.log(arg.link);
          // Download the file using axios and stream to disk
          await new Promise<void>((resolve_dw, reject_dw) =>
            axios({
              method: 'get',
              url: arg.link,
              responseType: 'stream',
            })
              .then((response) => {
                // Listen for abort event from frontend
                ipcMain.handleOnce(`ddl:${downloadID}:abort`, () => {
                  response.data.destroy();
                  fileStream.close();
                  fs.unlinkSync(arg.path);
                  console.log('Downloaded aborted');
                  mainWindow.webContents.send('ddl:download-error', {
                    id: downloadID,
                    error: 'Download aborted',
                  });
                  sendNotification({
                    message: 'Download aborted',
                    id: downloadID,
                    type: 'error',
                  });
                  finish();
                  reject_dw();
                });

                // Get file size from response headers
                let fileSize = response.headers['content-length']!!;
                const startTime = Date.now();
                // Pipe response data to file
                response.data.pipe(fileStream);

                // --- Throttled progress reporting setup ---
                let lastProgress = 0;
                let lastDownloadSpeed = 0;
                let finished = false;
                // Timer to send progress every 500ms
                const progressInterval = setInterval(() => {
                  if (mainWindow && mainWindow.webContents && !finished) {
                    mainWindow.webContents.send('ddl:download-progress', {
                      id: downloadID,
                      progress: lastProgress,
                      downloadSpeed: lastDownloadSpeed,
                      fileSize,
                      part: parts,
                      totalParts: args.length,
                      queuePosition: 1,
                    });
                  }
                }, 500);
                // --- End throttled setup ---

                // Report progress on each data chunk (just update vars)
                response.data.on('data', () => {
                  lastProgress = fileStream.bytesWritten / fileSize;
                  const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
                  const bytesRead =
                    response.data?.socket?.bytesRead ?? fileStream.bytesWritten;
                  lastDownloadSpeed = bytesRead / elapsedTime;
                });

                // Handle download completion
                response.data.on('end', () => {
                  finished = true;
                  clearInterval(progressInterval);
                  // Send one last progress update at 100%
                  if (mainWindow && mainWindow.webContents) {
                    mainWindow.webContents.send('ddl:download-progress', {
                      id: downloadID,
                      progress: 1,
                      downloadSpeed: lastDownloadSpeed,
                      fileSize,
                      part: parts,
                      totalParts: args.length,
                      queuePosition: 1,
                    });
                  }
                  console.log('Download complete for part ' + parts);
                  fileStream.close();
                  resolve_dw();
                });

                // Handle download errors
                response.data.on('error', () => {
                  finished = true;
                  clearInterval(progressInterval);
                  if (mainWindow && mainWindow.webContents)
                    mainWindow.webContents.send('ddl:download-error', {
                      id: downloadID,
                      error: '',
                    });
                  fileStream.close();
                  fs.unlinkSync(arg.path);
                  finish();
                  reject_dw();
                });
              })
              .catch((err) => {
                // Handle axios/network errors
                console.error(err);
                if (mainWindow && mainWindow.webContents)
                  mainWindow.webContents.send('ddl:download-error', {
                    id: downloadID,
                    error: err,
                  });
                fileStream.close();
                fs.unlinkSync(arg.path);
                sendNotification({
                  message: 'Download failed for ' + arg.path,
                  id: downloadID,
                  type: 'error',
                });
                finish();
                reject_dw();
              })
          );
        }
        // Notify frontend of completion of all downloads in batch
        if (mainWindow && mainWindow.webContents)
          mainWindow.webContents.send('ddl:download-complete', {
            id: downloadID,
          });
        finish();
        resolve();
      })
        .then(() => {
          // Log successful completion
          console.log('Download complete!!');
        })
        .catch((err) => {
          // Log and notify on failure
          console.log('Download failed');
          sendNotification({
            message: 'Direct Download Failed',
            id: downloadID,
            type: 'error',
          });
          finish();
          console.error(err);
        });
      // Return the download ID to the frontend for tracking
      return downloadID;
    }
  );
}
