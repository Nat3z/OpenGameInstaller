import { ipcMain } from 'electron';
import * as fs from 'fs';
import { sendNotification } from '../main.js';
import axios, { AxiosResponse } from 'axios';
import { __dirname } from '../paths.js';
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
  // Also cleanup abort handler
  ipcMain.removeHandler(`ddl:${context.downloadID}:abort`);
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

// Helper function to setup download event handlers
function setupDownloadEventHandlers(
  context: DownloadContext,
  finish: () => void,
  resolve: () => void,
  reject: () => void
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
  context.response.data.on('end', () => {
    if (context.isPaused) {
      console.log('Download was paused, ignoring end event');
      return;
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

    console.log(`Download complete for part ${context.parts || 1}`);
    resolve();
  });

  // Handle download errors
  context.response.data.on('error', (error) => {
    handleDownloadError(context, error, finish, reject);
  });
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
    return await handleResume(
      context.downloadID,
      context.mainWindow,
      context.url
    );
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
  parts?: number,
  totalParts?: number,
  finish?: () => void
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const { startByte, existingSize } = getResumeInfo(filePath);
    let fileStream = setupFileStream(filePath, startByte);

    console.log('Starting download...');

    fileStream.on('error', (err) => {
      console.error(err);
      sendIpcMessage(mainWindow, 'ddl:download-error', {
        id: downloadID,
        error: err,
      });
      fileStream.close();
      if (finish) finish();
      reject();
    });

    console.log(url);

    const headers: any = {};
    if (startByte > 0) {
      headers.Range = `bytes=${startByte}-`;
      console.log(`Requesting resume from byte ${startByte}`);
    }

    try {
      const response = await axios<Readable>({
        method: 'get',
        url: url,
        responseType: 'stream',
        headers,
      });

      // Setup abort handler - remove existing handler first to prevent conflicts
      ipcMain.removeHandler(`ddl:${downloadID}:abort`);
      ipcMain.handleOnce(`ddl:${downloadID}:abort`, () => {
        response.data.destroy();
        fileStream.close();
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        cleanupPauseResumeHandlers(downloadID);
        console.log('Download aborted');
        sendIpcMessage(mainWindow, 'ddl:download-error', {
          id: downloadID,
          error: 'Download aborted',
        });
        sendNotification({
          message: 'Download aborted',
          id: downloadID,
          type: 'error',
        });
        if (finish) finish();
        reject();
      });

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
      };

      // Setup progress tracking
      setupProgressTracking(context);

      // Setup pause/resume handlers
      setupPauseResumeHandlers(context);

      // Pipe response data to file
      response.data.pipe(fileStream);

      // Setup event handlers
      setupDownloadEventHandlers(
        context,
        finish || (() => {}),
        resolve,
        reject
      );
    } catch (err) {
      // Handle axios/network errors
      console.error(err);
      // Ensure abort handler is cleaned up on error
      ipcMain.removeHandler(`ddl:${downloadID}:abort`);
      cleanupPauseResumeHandlers(downloadID);
      sendIpcMessage(mainWindow, 'ddl:download-error', {
        id: downloadID,
        error: err,
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
  });
}

// Helper function to handle resume functionality
async function handleResume(
  downloadID: string,
  mainWindow: Electron.BrowserWindow,
  currentUrl: string
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
      state.parts,
      state.totalParts
    );
    sendIpcMessage(mainWindow, 'ddl:download-complete', {
      id: downloadID,
    });

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
  ipcMain.removeHandler(`ddl:${downloadID}:abort`);
  downloadStates.delete(downloadID);
  downloadContexts.delete(downloadID);
}

// Helper function to setup file stream with error handling
function setupFileStream(filePath: string, startByte: number): fs.WriteStream {
  // Ensure directory exists
  fs.mkdirSync(filePath.split('/').slice(0, -1).join('/'), {
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
        console.log('New Download');
        console.log(`[${downloadID}] Initial position: ${initialPosition}`);
        cancelHandler((cancel) => {
          ipcMain.handleOnce(`queue:${downloadID}:cancel`, (_) => {
            cancel();
          });
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
          reject();
          return;
        }

        let parts = 0;
        for (const arg of args) {
          parts++;
          await executeDownload(
            downloadID,
            mainWindow,
            arg.link,
            arg.path,
            parts,
            args.length,
            finish
          );
        }

        // Notify frontend of completion of all downloads in batch
        sendIpcMessage(mainWindow, 'ddl:download-complete', {
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
