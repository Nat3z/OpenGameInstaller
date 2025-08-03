import { ipcMain } from 'electron';
import * as fs from 'fs';
import { sendNotification } from '../main.js';
import axios, { AxiosResponse } from 'axios';
import { __dirname } from '../paths.js';
import { dirname } from 'path';
import { DOWNLOAD_QUEUE } from '../queue.js';
import { Readable } from 'stream';

// Types for better type safety
interface DownloadState {
  url: string;
  filePath: string;
  currentBytes: number;
  totalSize: number;
  startByte: number;
  isPaused: boolean;
  parts?: number;
  totalParts?: number;
}

interface ProgressData {
  id: string;
  progress: number;
  downloadSpeed: number;
  fileSize: number;
  part?: number;
  totalParts?: number;
  queuePosition: number;
}

interface DownloadContext {
  downloadID: string;
  mainWindow: Electron.BrowserWindow;
  fileStream: fs.WriteStream;
  progressInterval: NodeJS.Timeout;
  response: AxiosResponse<Readable>;
  url: string;
  filePath: string;
  currentBytes: number;
  totalSize: number;
  startByte: number;
  isPaused: boolean;
  finished: boolean;
  startTime: number;
  parts?: number;
  totalParts?: number;
  headersAdditional: Record<string, string>;
  taskFinisher: () => void;
}

// Store download states for resume functionality
const downloadStates: Map<string, DownloadState> = new Map();

// Store download contexts for pause/resume functionality
const downloadContexts: Map<string, DownloadContext> = new Map();

// Helper function to safely send IPC messages
function sendIpcMessage(
  mainWindow: Electron.BrowserWindow,
  channel: string,
  data: any
): void {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send(channel, data);
  }
}

// Helper function to send progress updates
function sendProgressUpdate(
  mainWindow: Electron.BrowserWindow,
  progressData: ProgressData
): void {
  sendIpcMessage(mainWindow, 'ddl:download-progress', progressData);
}

// Helper function to cleanup download resources
function cleanupDownload(context: DownloadContext): void {
  context.finished = true;
  clearInterval(context.progressInterval);
  context.fileStream.close();
  cleanupPauseResumeHandlers(context.downloadID);
}

// Helper function to handle download errors
function handleDownloadError(
  context: DownloadContext,
  error: any,
  finish: () => void,
  reject: () => void
): void {
  if (context.isPaused) {
    console.log('Download was paused, ignoring error event');
    return;
  }

  cleanupDownload(context);
  sendIpcMessage(context.mainWindow, 'ddl:download-error', {
    id: context.downloadID,
    error: error.message || 'Download error',
  });

  // Clean up file if it exists
  try {
    if (fs.existsSync(context.filePath)) {
      fs.unlinkSync(context.filePath);
    }
  } catch (unlinkError) {
    console.error('Failed to unlink file:', unlinkError);
  }

  finish();
  reject();
}

// Helper function to setup progress tracking
function setupProgressTracking(context: DownloadContext): void {
  const progressInterval = setInterval(() => {
    if (context.mainWindow?.webContents && !context.finished) {
      const progressData: ProgressData = {
        id: context.downloadID,
        progress: context.currentBytes / context.totalSize,
        downloadSpeed:
          context.currentBytes > context.startByte
            ? (context.currentBytes - context.startByte) /
              ((Date.now() - context.startTime) / 1000)
            : 0,
        fileSize: context.totalSize,
        queuePosition: 1,
      };

      if (context.parts !== undefined) {
        progressData.part = context.parts;
        progressData.totalParts = context.totalParts;
      }

      sendProgressUpdate(context.mainWindow, progressData);
    }
  }, 500);

  context.progressInterval = progressInterval;
}

// Helper function to setup pause/resume handlers
function setupPauseResumeHandlers(context: DownloadContext): void {
  // Remove existing handlers first to avoid conflicts
  cleanupPauseResumeHandlers(context.downloadID);

  // Store the context for this download
  console.log('Stored context for downloadID:', context.downloadID);
  downloadContexts.set(context.downloadID, context);

  // Register pause handler
  ipcMain.handle(`ddl:${context.downloadID}:pause`, () => {
    console.log('Pause event received');
    const currentContext = downloadContexts.get(context.downloadID);
    if (currentContext) {
      console.log('Current context:', currentContext);
      handlePause(currentContext);
      return true;
    } else {
      console.log('No current context found');
      return false;
    }
  });

  // Register resume handler
  ipcMain.handle(`ddl:${context.downloadID}:resume`, async () => {
    console.log('Resume event received');
    const resumeSuccess = await handleResume(
      context.downloadID,
      context.mainWindow,
      context.url,
      context.headersAdditional,
      context.taskFinisher
    );

    if (!resumeSuccess) {
      console.log('Resume failed, restarting download from beginning...');

      // Send notification about resume failure and restart
      sendNotification({
        message: 'Resume failed, restarting download',
        id: context.downloadID,
        type: 'warning',
      });

      // Get the current context to access file path and other details
      const currentContext = downloadContexts.get(context.downloadID);
      if (currentContext) {
        // Clean up current download state
        cleanupDownload(currentContext);
      }

      // Clean up the partial file
      try {
        const state = downloadStates.get(context.downloadID);
        if (state && fs.existsSync(state.filePath)) {
          fs.unlinkSync(state.filePath);
        }
      } catch (unlinkError) {
        console.error('Failed to unlink file during restart:', unlinkError);
      }

      // Restart the download from the beginning
      try {
        const state = downloadStates.get(context.downloadID);
        if (state) {
          await executeDownload(
            context.downloadID,
            context.mainWindow,
            state.url,
            state.filePath,
            context.headersAdditional,
            state.parts,
            state.totalParts,
            context.taskFinisher
          );
        }
      } catch (restartError) {
        console.error(
          'Failed to restart download after resume failure:',
          restartError
        );
        sendIpcMessage(context.mainWindow, 'ddl:download-error', {
          id: context.downloadID,
          error: 'Download failed after resume restart',
        });
        sendNotification({
          message: 'Download failed after resume restart',
          id: context.downloadID,
          type: 'error',
        });
      }
    }

    return resumeSuccess;
  });
}

// Helper function to handle pause functionality
function handlePause(context: DownloadContext): boolean {
  console.log('Pausing system...');
  if (!context.isPaused) {
    // Store download state for resume
    downloadStates.set(context.downloadID, {
      url: context.url,
      filePath: context.filePath,
      currentBytes: context.currentBytes,
      totalSize: context.totalSize,
      startByte: context.startByte,
      isPaused: true,
      parts: context.parts,
      totalParts: context.totalParts,
    });

    // Properly pause by destroying the stream and stopping progress
    context.response.data.destroy();
    context.fileStream.end();
    clearInterval(context.progressInterval);

    console.log(
      `Download paused at ${context.currentBytes}/${context.totalSize} bytes`
    );
    sendIpcMessage(context.mainWindow, 'ddl:download-paused', {
      id: context.downloadID,
    });
    sendNotification({
      message: 'Download paused',
      id: context.downloadID,
      type: 'info',
    });
    return true;
  }
  return false;
}

// Helper function to execute a download with full setup
async function executeDownload(
  downloadID: string,
  mainWindow: Electron.BrowserWindow,
  url: string,
  filePath: string,
  headersAdditional: Record<string, string>,
  parts?: number,
  totalParts?: number,
  finish?: () => void,
  hasRetriedForSmallFile: boolean = false
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const executeDownloadAttempt = async (isRetry: boolean = false) => {
      const { startByte, existingSize } = isRetry
        ? { startByte: 0, existingSize: 0 }
        : getResumeInfo(filePath);
      let fileStream = setupFileStream(filePath, startByte);

      console.log(
        isRetry ? 'Retrying download from beginning...' : 'Starting download...'
      );

      fileStream.on('error', (err) => {
        console.error(err);
        sendIpcMessage(mainWindow, 'ddl:download-error', {
          id: downloadID,
          error: 'File stream error',
        });
        fileStream.close();
        if (finish) finish();
        reject();
      });

      console.log(url);

      const headers: Record<string, string> = {
        ...headersAdditional,
        'User-Agent': 'OpenGameInstaller Downloader/1.0.0',
      };
      if (startByte > 0) {
        headers.Range = `bytes=${startByte}-`;
        console.log(`Requesting resume from byte ${startByte}`);
      }

      try {
        console.log('Starting download with headers:', headers);
        const response = await axios<Readable>({
          method: 'get',
          url: url,
          responseType: 'stream',
          headers,
        });

        // Note: Global abort handler is registered at the queue level
        // No need for a separate abort handler here since the global one handles all cases

        // Get file size and handle range request issues
        let totalSize = getFileSizeFromResponse(response, startByte);

        // Handle case where server doesn't support range requests
        let actualStartByte = existingSize;
        let actualCurrentBytes = existingSize;
        if (startByte > 0 && response.status !== 206) {
          console.log(
            'Server does not support range requests, restarting download'
          );
          fileStream.close();
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          fileStream = setupFileStream(filePath, 0);
          totalSize = response.headers['content-length'];
          // Reset byte counters since we're starting fresh
          actualStartByte = 0;
          actualCurrentBytes = 0;
        }

        // Create download context
        const context: DownloadContext = {
          downloadID,
          mainWindow,
          fileStream,
          progressInterval: null as any, // Will be set by setupProgressTracking
          response,
          url: url,
          filePath: filePath,
          currentBytes: actualCurrentBytes,
          totalSize,
          startByte: actualStartByte,
          isPaused: false,
          finished: false,
          startTime: Date.now(),
          parts,
          totalParts,
          headersAdditional,
          taskFinisher: finish || (() => {}),
        };

        // Setup progress tracking
        setupProgressTracking(context);

        // Setup pause/resume handlers
        setupPauseResumeHandlers(context);

        // Pipe response data to file
        response.data.pipe(fileStream);

        // Setup event handlers with retry logic
        setupDownloadEventHandlersWithRetry(
          context,
          finish || (() => {}),
          resolve,
          reject,
          startByte > 0 && !isRetry,
          headersAdditional,
          executeDownloadAttempt,
          hasRetriedForSmallFile
        );
      } catch (err) {
        // Handle axios/network errors with retry logic
        console.error(err);

        // If this was a resume attempt and not already a retry, try again from beginning
        if (startByte > 0 && !isRetry) {
          console.log('Resume attempt failed, retrying from beginning...');
          // Clean up current attempt
          ipcMain.removeHandler(`ddl:${downloadID}:abort`);
          cleanupPauseResumeHandlers(downloadID);
          fileStream.close();
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }

          // Retry from beginning
          try {
            await executeDownloadAttempt(true);
            // Success - resolve will be called by the retry
            return;
          } catch (retryErr) {
            // If retry also fails, give up
            console.error('Retry also failed:', retryErr);
            sendIpcMessage(mainWindow, 'ddl:download-error', {
              id: downloadID,
              error: 'Download failed after retry',
            });
            sendNotification({
              message: 'Download failed for ' + filePath,
              id: downloadID,
              type: 'error',
            });
            if (finish) finish();
            reject();
            return;
          }
        } else {
          // This was already a retry or not a resume attempt, give up
          ipcMain.removeHandler(`ddl:${downloadID}:abort`);
          cleanupPauseResumeHandlers(downloadID);
          sendIpcMessage(mainWindow, 'ddl:download-error', {
            id: downloadID,
            error: 'File stream error',
          });
          fileStream.close();
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          sendNotification({
            message: 'Download failed for ' + filePath,
            id: downloadID,
            type: 'error',
          });
          if (finish) finish();
          reject();
        }
      }
    };

    // Start the download attempt
    await executeDownloadAttempt();
  });
}

// Helper function to setup download event handlers with retry capability
function setupDownloadEventHandlersWithRetry(
  context: DownloadContext,
  finish: () => void,
  resolve: () => void,
  reject: () => void,
  canRetry: boolean,
  headersAdditional: Record<string, string>,
  retryFunction: (isRetry: boolean) => Promise<void>,
  hasRetriedForSmallFile: boolean
): void {
  // Track progress on data chunks
  context.response.data.on('data', (chunk: Buffer) => {
    context.currentBytes += chunk.length;

    // Update download state for pause/resume
    downloadStates.set(context.downloadID, {
      url: context.url,
      filePath: context.filePath,
      currentBytes: context.currentBytes,
      totalSize: context.totalSize,
      startByte: context.startByte,
      isPaused: context.isPaused,
      parts: context.parts,
      totalParts: context.totalParts,
    });
  });

  // Handle download completion
  context.response.data.on('end', async () => {
    if (context.isPaused) {
      console.log('Download was paused, ignoring end event');
      return;
    }

    // Check if file size is under 1MB and retry if needed (only if we haven't already retried for this reason)
    const fileSizeInMB = context.totalSize / (1024 * 1024);
    if ((isNaN(fileSizeInMB) || fileSizeInMB < 1) && !hasRetriedForSmallFile) {
      console.log(
        `File size is ${fileSizeInMB.toFixed(2)}MB (under 1MB), retrying download...`
      );

      cleanupDownload(context);

      // Clean up the small file
      try {
        if (fs.existsSync(context.filePath)) {
          fs.unlinkSync(context.filePath);
        }
      } catch (unlinkError) {
        console.error('Failed to unlink small file:', unlinkError);
      }

      try {
        // Retry with the small file flag set to true to prevent infinite recursion
        // Don't pass finish to the retry - let this level handle completion/errors
        await executeDownload(
          context.downloadID,
          context.mainWindow,
          context.url,
          context.filePath,
          headersAdditional,
          context.parts,
          context.totalParts,
          undefined, // Don't pass finish to retry
          true // hasRetriedForSmallFile = true
        );
        resolve(); // Resolve the original promise
        return; // Exit early, retry completed successfully
      } catch (retryError) {
        console.error('Retry for small file failed:', retryError);
        sendIpcMessage(context.mainWindow, 'ddl:download-error', {
          id: context.downloadID,
          error: 'Download failed after retry (file too small)',
        });
        finish();
        reject();
        return;
      }
    }

    cleanupDownload(context);

    // Send final progress update
    sendProgressUpdate(context.mainWindow, {
      id: context.downloadID,
      progress: 1,
      downloadSpeed: 0,
      fileSize: context.totalSize,
      part: context.parts,
      totalParts: context.totalParts,
      queuePosition: 1,
    });

    console.log(
      `Download complete for part ${context.parts || 1} (${fileSizeInMB.toFixed(2)}MB)`
    );
    resolve();
  });

  // Handle download errors with retry logic
  context.response.data.on('error', async (error) => {
    if (context.isPaused) {
      console.log('Download was paused, ignoring error event');
      return;
    }

    // If this was a resume attempt, try retrying from beginning
    if (canRetry) {
      console.log('Resume download failed, retrying from beginning...');
      cleanupDownload(context);

      // Clean up the partial file
      try {
        if (fs.existsSync(context.filePath)) {
          fs.unlinkSync(context.filePath);
        }
      } catch (unlinkError) {
        console.error('Failed to unlink file:', unlinkError);
      }

      try {
        await retryFunction(true);
      } catch (retryError) {
        console.error('Retry failed:', retryError);
        sendIpcMessage(context.mainWindow, 'ddl:download-error', {
          id: context.downloadID,
          error: 'Download failed after retry',
        });
        finish();
        reject();
      }
    } else {
      // Handle as normal error
      handleDownloadError(context, error, finish, reject);
    }
  });
}

// Helper function to handle resume functionality
async function handleResume(
  downloadID: string,
  mainWindow: Electron.BrowserWindow,
  currentUrl: string,
  headersAdditional: Record<string, string>,
  finish?: () => void
): Promise<boolean> {
  const state = downloadStates.get(downloadID);
  if (!state || !state.isPaused) {
    console.log('No paused download state found for', downloadID);
    return false;
  }

  try {
    console.log(
      `Resuming download from ${state.currentBytes}/${state.totalSize} bytes`
    );

    // Update state to not paused
    state.isPaused = false;
    downloadStates.set(downloadID, state);

    // Use the same executeDownload function to ensure consistent setup
    sendIpcMessage(mainWindow, 'ddl:download-resumed', {
      id: downloadID,
    });
    await executeDownload(
      downloadID,
      mainWindow,
      currentUrl,
      state.filePath,
      headersAdditional,
      state.parts,
      state.totalParts,
      finish
    );

    console.log('Download resumed successfully');

    return true;
  } catch (error) {
    console.error('Failed to resume download:', error);
    downloadStates.delete(downloadID);
    return false;
  }
}

// Helper function to cleanup pause/resume handlers
function cleanupPauseResumeHandlers(downloadID: string) {
  // Remove handlers - removeHandler doesn't throw if handler doesn't exist
  ipcMain.removeHandler(`ddl:${downloadID}:pause`);
  ipcMain.removeHandler(`ddl:${downloadID}:resume`);
  // Note: Don't remove abort handler here since it's managed globally
  downloadStates.delete(downloadID);
  downloadContexts.delete(downloadID);
}

// Helper function to setup file stream with error handling
function setupFileStream(filePath: string, startByte: number): fs.WriteStream {
  // Ensure directory exists
  fs.mkdirSync(dirname(filePath), {
    recursive: true,
  });

  return fs.createWriteStream(filePath, startByte > 0 ? { flags: 'a' } : {});
}

// Helper function to determine file size from response
function getFileSizeFromResponse(
  response: AxiosResponse<Readable>,
  startByte: number
): number {
  let fileSize = response.headers['content-length'];
  let totalSize = fileSize;

  // Handle partial content response
  if (response.status === 206 && response.headers['content-range']) {
    const range = response.headers['content-range'];
    const match = range.match(/bytes \d+-\d+\/(\d+)/);
    if (match) {
      totalSize = parseInt(match[1], 10);
      console.log(
        `Partial content response, total size: ${totalSize}, content length: ${fileSize}`
      );
    }
  } else if (startByte > 0) {
    // Server doesn't support range requests, we need to restart from beginning
    console.log('Server does not support range requests, restarting download');
    totalSize = fileSize;
  } else {
    totalSize = fileSize;
  }

  return totalSize;
}

// Helper function to check for existing file and get resume info
function getResumeInfo(filePath: string): {
  startByte: number;
  existingSize: number;
} {
  let startByte = 0;
  let existingSize = 0;

  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    existingSize = stats.size;
    startByte = existingSize;
    console.log(
      `Existing file found, size: ${existingSize} bytes, attempting resume`
    );
  }

  return { startByte, existingSize };
}

// Main handler function to register the direct download IPC handler
export default function handler(mainWindow: Electron.BrowserWindow) {
  // Register IPC handler for 'ddl:download' events
  ipcMain.handle(
    'ddl:download',
    // args: array of { link: string; path: string }
    async (
      _,
      args: { link: string; path: string; headers?: Record<string, string> }[]
    ) => {
      // Generate a unique ID for this download batch
      const downloadID = Math.random().toString(36).substring(7);
      // Enqueue the download in the global DOWNLOAD_QUEUE
      const { initialPosition, wait, finish, cancelHandler } =
        DOWNLOAD_QUEUE.enqueue(downloadID, {
          type: 'direct',
        });
      // Begin download process for each file in args
      new Promise<void>(async (resolve, reject) => {
        console.log('New Download');
        console.log(`[${downloadID}] Initial position: ${initialPosition}`);

        cancelHandler((cancel) => {
          ipcMain.handleOnce(`queue:${downloadID}:cancel`, (_) => {
            cancel();
          });
        });
        // Register global abort handler that works at any stage
        ipcMain.handleOnce(`ddl:${downloadID}:abort`, () => {
          console.log('Global abort handler triggered');

          // If it's still in the queue, remove it
          if (DOWNLOAD_QUEUE.remove(downloadID)) {
            console.log('Removed from queue during abort');
            sendIpcMessage(mainWindow, 'ddl:download-cancelled', {
              id: downloadID,
            });
            finish();
            reject();
            return;
          }

          // If it's already running, look up the active context
          const ctx = downloadContexts.get(downloadID);
          if (ctx) {
            console.log('Aborting active download context');
            ctx.response?.data?.destroy();
            ctx.fileStream?.close();
            if (fs.existsSync(ctx.filePath)) {
              fs.unlinkSync(ctx.filePath);
            }
            cleanupDownload(ctx);
          }

          // Always advance the queue
          finish();
          sendIpcMessage(mainWindow, 'ddl:download-error', {
            id: downloadID,
            error: 'Download aborted',
          });
          sendNotification({
            message: 'Download aborted',
            id: downloadID,
            type: 'error',
          });
          reject();
        });

        // Wait for our turn in the queue, reporting position to frontend
        const result = await wait((queuePosition) => {
          console.log(
            `[${downloadID}] Updated Queue position: ${queuePosition}`
          );
          sendIpcMessage(mainWindow, 'ddl:download-progress', {
            id: downloadID,
            queuePosition,
          });
        });

        ipcMain.removeHandler(`queue:${downloadID}:cancel`);

        if (result === 'cancelled') {
          sendIpcMessage(mainWindow, 'ddl:download-cancelled', {
            id: downloadID,
          });
          finish(); // Must call finish() to allow queue to progress
          // Clean up the global abort handler
          ipcMain.removeHandler(`ddl:${downloadID}:abort`);
          reject();
          return;
        }

        try {
          let parts = 0;
          const totalParts = args.length;

          for (const arg of args) {
            parts++;
            console.log(`Starting part ${parts} of ${totalParts}`);

            // Don't pass finish() to individual parts - we'll handle it at the end
            // The global abort handler will call finish() if needed
            await executeDownload(
              downloadID,
              mainWindow,
              arg.link,
              arg.path,
              arg.headers || {},
              parts,
              totalParts,
              undefined // Don't pass finish() here to avoid double-calling
            );

            console.log(`Completed part ${parts} of ${totalParts}`);
          }

          // All parts completed successfully
          console.log(
            `All ${totalParts} parts completed for download ${downloadID}`
          );

          // Notify frontend of completion of all downloads in batch
          sendIpcMessage(mainWindow, 'ddl:download-complete', {
            id: downloadID,
          });
          // send an ipc-message for progress
          sendIpcMessage(mainWindow, 'ddl:download-progress', {
            id: downloadID,
            progress: 1,
            downloadSpeed: 0,
            fileSize: 0,
            queuePosition: 1,
          });

          // Now call finish() since all parts are done
          finish();
          // Clean up the global abort handler
          ipcMain.removeHandler(`ddl:${downloadID}:abort`);
          resolve();
        } catch (error) {
          console.error('Error during multi-part download:', error);
          finish();
          // Clean up the global abort handler
          ipcMain.removeHandler(`ddl:${downloadID}:abort`);
          reject(error);
        }
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
          // finish() is already called in the try-catch above, don't call it again
          console.error(err);
        });
      // Return the download ID to the frontend for tracking
      return downloadID;
    }
  );
}
