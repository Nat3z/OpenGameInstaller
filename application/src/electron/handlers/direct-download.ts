import { ipcMain } from 'electron';
import * as fs from 'fs';
import { sendNotification } from '../main.js';
import axios, { AxiosResponse } from 'axios';
import { __dirname } from '../paths.js';
import { dirname } from 'path';
import { DOWNLOAD_QUEUE } from '../queue.js';
import { Readable } from 'stream';
import * as http from 'http';
import * as https from 'https';

// Types for better type safety
// Unified interface for all downloads (single-part and multi-part)
interface MultiPartDownloadState {
  downloadID: string;
  mainWindow: Electron.BrowserWindow;
  args: { link: string; path: string; headers?: Record<string, string> }[];
  currentPart: number;
  totalParts: number;
  headersAdditional: Record<string, string>;
  taskFinisher: () => void;
  isPaused: boolean;
  completedParts: Set<number>;
  // Additional fields for individual part tracking
  currentBytes?: number;
  totalSize?: number;
  startByte?: number;
  currentFilePath?: string;
  currentUrl?: string;
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
  // Number of times we've attempted to resume this specific part
  resumeRetryCount?: number;
}

// Store download states for resume functionality (unified for single and multi-part)
const downloadStates: Map<string, MultiPartDownloadState> = new Map();

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
function cleanupDownload(
  context: DownloadContext,
  // If undefined, auto-detect based on whether this is the last part
  finalCleanup?: boolean
): void {
  context.finished = true;
  clearInterval(context.progressInterval);
  context.fileStream.close();
  const isFinalPart =
    finalCleanup !== undefined
      ? finalCleanup
      : !context.totalParts || context.parts === context.totalParts;
  cleanupPauseResumeHandlers(context.downloadID, isFinalPart);
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

  // This is a terminal error for this batch - perform final cleanup
  cleanupDownload(context, true);
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
      const totalBytes = Number.isFinite(context.totalSize)
        ? context.totalSize
        : 0;
      const progressData: ProgressData = {
        id: context.downloadID,
        progress: totalBytes > 0 ? context.currentBytes / totalBytes : 0,
        downloadSpeed:
          context.currentBytes > context.startByte
            ? (context.currentBytes - context.startByte) /
              ((Date.now() - context.startTime) / 1000)
            : 0,
        fileSize: totalBytes,
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
  ipcMain.removeHandler(`ddl:${context.downloadID}:pause`);
  ipcMain.removeHandler(`ddl:${context.downloadID}:resume`);
  // Note: Don't remove abort handler here since it's managed globally
  // Note: Don't delete download state here since it should persist throughout the download

  // Store the context for this download
  console.log('Stored context for downloadID:', context.downloadID);
  downloadContexts.set(context.downloadID, context);

  // Register pause handler
  ipcMain.handle(`ddl:${context.downloadID}:pause`, () => {
    console.log('Pause event received');
    const currentContext = downloadContexts.get(context.downloadID);
    if (currentContext) {
      // console.log('Current context:', currentContext);
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

    // Get the unified download state
    const downloadState = downloadStates.get(context.downloadID);
    if (downloadState && downloadState.isPaused) {
      // Handle unified download resume (works for both single and multi-part)
      console.log('Resuming download from part', downloadState.currentPart);
      const resumeSuccess = await handleUnifiedResume(downloadState);

      if (!resumeSuccess) {
        console.log('Resume failed');
        sendIpcMessage(context.mainWindow, 'ddl:download-error', {
          id: context.downloadID,
          error: 'Failed to resume download',
        });
      }

      return resumeSuccess;
    } else {
      console.log('No paused download state found for', context.downloadID);
      console.log(
        'Available download states:',
        Array.from(downloadStates.keys())
      );
      console.log('Download state exists:', !!downloadState);
      if (downloadState) {
        console.log('Download state isPaused:', downloadState.isPaused);
      }

      sendIpcMessage(context.mainWindow, 'ddl:download-error', {
        id: context.downloadID,
        error: 'No paused download found to resume',
      });
      return false;
    }
  });
}

// Helper function to handle pause functionality
function handlePause(context: DownloadContext): boolean {
  console.log('Pausing system...');
  if (!context.isPaused) {
    // Mark context as paused early to avoid race conditions with end/error handlers
    context.isPaused = true;
    // Get the unified download state
    const downloadState = downloadStates.get(context.downloadID);
    console.log(
      'Download state found:',
      !!downloadState,
      'for ID:',
      context.downloadID
    );
    console.log(
      'Available download states:',
      Array.from(downloadStates.keys())
    );

    if (downloadState) {
      // Update the unified download state with current part information
      downloadState.isPaused = true;
      downloadState.currentPart = context.parts || 1;
      downloadState.currentBytes = context.currentBytes;
      downloadState.totalSize = context.totalSize;
      downloadState.startByte = context.startByte;
      downloadState.currentFilePath = context.filePath;
      downloadState.currentUrl = context.url;
      downloadStates.set(context.downloadID, downloadState);
      console.log('Updated download state:', downloadState);
    } else {
      console.error('No download state found for ID:', context.downloadID);
      console.log(
        'Available download states:',
        Array.from(downloadStates.keys())
      );

      // This should never happen if the unified system is working correctly
      // The download state should be created when the download starts
      console.error(
        'CRITICAL: Download state missing - this indicates a bug in the unified system'
      );

      // Don't create a fallback state as it would be incomplete
      // Instead, just pause the current context and let the user restart the download
      console.log('Pausing without state - download will need to be restarted');
    }

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
// Reusable keep-alive agents for stability
const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

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
        // Ensure raw bytes for range requests (avoid on-the-fly compression)
        'Accept-Encoding': 'identity',
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
          // Improve network resilience
          httpAgent: keepAliveHttpAgent,
          httpsAgent: keepAliveHttpsAgent,
          maxRedirects: 5,
        });

        // Note: Global abort handler is registered at the queue level
        // No need for a separate abort handler here since the global one handles all cases

        // Get file size and handle range request issues
        let totalSize = getFileSizeFromResponse(response, startByte);

        // Handle case where server doesn't support or mis-honors range requests
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
          const cl = response.headers['content-length'];
          totalSize = cl ? parseInt(cl as any, 10) : NaN;
          // Reset byte counters since we're starting fresh
          actualStartByte = 0;
          actualCurrentBytes = 0;
        } else if (startByte > 0 && response.status === 206) {
          // Validate that the server's Content-Range start matches our file size
          const cr = response.headers['content-range'] as string | undefined;
          let serverRangeStart: number | null = null;
          if (cr) {
            const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
            if (m) {
              serverRangeStart = parseInt(m[1], 10);
            }
          }

          if (serverRangeStart === null) {
            console.log(
              'No Content-Range start provided with 206; restarting from beginning to avoid corruption'
            );
            response.data.destroy();
            fileStream.close();
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            await executeDownloadAttempt(true);
            return;
          }

          if (serverRangeStart !== existingSize) {
            if (serverRangeStart < existingSize) {
              console.log(
                `Server range starts earlier (${serverRangeStart}) than local size (${existingSize}); rewinding write position to avoid duplication`
              );
              // Reopen stream positioned at the server's start to overwrite overlap safely
              fileStream.close();
              fileStream = fs.createWriteStream(filePath, {
                flags: 'r+',
                start: serverRangeStart,
              });
              actualStartByte = serverRangeStart;
              actualCurrentBytes = serverRangeStart;
            } else {
              console.log(
                `Server range starts beyond local size (${serverRangeStart} > ${existingSize}); restarting from beginning`
              );
              response.data.destroy();
              fileStream.close();
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
              await executeDownloadAttempt(true);
              return;
            }
          }
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
          resumeRetryCount: 0,
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
          console.error('file stream error', err);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          sendNotification({
            message: 'Download failed for ' + filePath,
            id: downloadID,
            type: 'error',
          });
          if (finish) finish();
          reject(err);
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

    // Update the unified download state with current progress
    const downloadState = downloadStates.get(context.downloadID);
    if (downloadState) {
      downloadState.currentBytes = context.currentBytes;
      downloadState.totalSize = context.totalSize;
      downloadState.startByte = context.startByte;
      downloadState.currentFilePath = context.filePath;
      downloadState.currentUrl = context.url;
    }
  });

  // Handle download completion
  context.response.data.on('end', async () => {
    if (context.isPaused) {
      console.log('Download was paused, ignoring end event');
      return;
    }

    // Use actually downloaded bytes to detect bogus tiny files
    const downloadedBytes = context.currentBytes;
    const downloadedMB = downloadedBytes / (1024 * 1024);
    if (downloadedBytes < 1 * 1024 * 1024 && !hasRetriedForSmallFile) {
      console.log(
        `Downloaded size is ${downloadedMB.toFixed(2)}MB (under 1MB), retrying download...`
      );

      // Cleanup but keep state so we can retry this part
      cleanupDownload(context, false);

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
      fileSize: Number.isFinite(context.totalSize)
        ? context.totalSize
        : downloadedBytes,
      part: context.parts,
      totalParts: context.totalParts,
      queuePosition: 1,
    });

    console.log(
      `Download complete for part ${context.parts || 1} (${downloadedMB.toFixed(2)}MB)`
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
      cleanupDownload(context, false);

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
      // Attempt limited auto-resume using Range from the bytes already written
      const MAX_RESUME_RETRIES = 3;
      context.resumeRetryCount = (context.resumeRetryCount || 0) + 1;
      if (context.resumeRetryCount <= MAX_RESUME_RETRIES) {
        console.log(
          `Stream error encountered. Attempting auto-resume #${context.resumeRetryCount}...`
        );
        // Cleanup but keep partial file for resume
        cleanupDownload(context, false);
        // Small backoff before retry
        await new Promise((r) => setTimeout(r, 1500));
        try {
          await retryFunction(false); // This will use getResumeInfo(filePath)
          return;
        } catch (resumeErr) {
          console.error('Auto-resume attempt failed:', resumeErr);
          // Will fall through to terminal failure below
        }
      }

      // Handle as terminal error
      handleDownloadError(context, error, finish, reject);
    }
  });
}

// Helper function to handle unified resume functionality (works for both single and multi-part)
async function handleUnifiedResume(
  downloadState: MultiPartDownloadState
): Promise<boolean> {
  try {
    console.log('Resuming download from part', downloadState.currentPart);

    // Mark as not paused
    downloadState.isPaused = false;

    // Send resume notification immediately
    sendIpcMessage(downloadState.mainWindow, 'ddl:download-resumed', {
      id: downloadState.downloadID,
    });

    // Start the download from the current part
    // Don't await it - let it run asynchronously
    executeUnifiedDownload(downloadState)
      .then(() => {
        // Handle successful completion
        console.log('Download resumed and completed successfully');

        // Send completion notification for resumed downloads
        sendIpcMessage(downloadState.mainWindow, 'ddl:download-complete', {
          id: downloadState.downloadID,
        });

        // Send final progress update
        sendProgressUpdate(downloadState.mainWindow, {
          id: downloadState.downloadID,
          progress: 1,
          downloadSpeed: 0,
          fileSize: downloadState.totalSize || 0,
          part: downloadState.totalParts,
          totalParts: downloadState.totalParts,
          queuePosition: 1,
        });

        // Clean up the download state since it's completed
        downloadStates.delete(downloadState.downloadID);
        downloadContexts.delete(downloadState.downloadID);
        console.log(
          'Deleted download state on completion for ID:',
          downloadState.downloadID
        );

        // Call finish function if provided to advance the queue
        if (downloadState.taskFinisher) {
          downloadState.taskFinisher();
        }
      })
      .catch((error) => {
        console.error('Resumed download failed:', error);
        sendIpcMessage(downloadState.mainWindow, 'ddl:download-error', {
          id: downloadState.downloadID,
          error: 'Resumed download failed',
        });
        sendNotification({
          message: 'Resumed download failed',
          id: downloadState.downloadID,
          type: 'error',
        });

        // Clean up the download state on error
        downloadStates.delete(downloadState.downloadID);
        downloadContexts.delete(downloadState.downloadID);
        console.log(
          'Deleted download state on error for ID:',
          downloadState.downloadID
        );

        // Call finish function if provided to advance the queue even on error
        if (downloadState.taskFinisher) {
          downloadState.taskFinisher();
        }
      });

    // Return true immediately to indicate resume operation started successfully
    return true;
  } catch (error) {
    console.error('Failed to start resume download:', error);
    downloadStates.delete(downloadState.downloadID);
    downloadContexts.delete(downloadState.downloadID);
    console.log(
      'Deleted download state on resume failure for ID:',
      downloadState.downloadID
    );
    return false;
  }
}

// Helper function to execute unified download from current part
async function executeUnifiedDownload(
  downloadState: MultiPartDownloadState
): Promise<void> {
  const { downloadID, mainWindow, args, currentPart, totalParts } =
    downloadState;

  console.log(`Executing download from part ${currentPart} to ${totalParts}`);

  // Start from the current part and continue through all remaining parts
  for (let part = currentPart || 1; part <= totalParts; part++) {
    const arg = args[part - 1];
    console.log(`Starting part ${part} of ${totalParts}`);

    // Update current part in state
    downloadState.currentPart = part;

    // Execute this part
    await executeDownload(
      downloadID,
      mainWindow,
      arg.link,
      arg.path,
      arg.headers || {},
      part,
      totalParts,
      undefined // Don't pass finish() here to avoid double-calling
    );

    console.log(`Completed part ${part} of ${totalParts}`);

    // Mark this part as completed
    downloadState.completedParts.add(part);
  }

  console.log(`All ${totalParts} parts completed for download ${downloadID}`);
}

// Helper function to cleanup pause/resume handlers
// Note: This function should only be called when the download is actually finished, failed, or aborted
// Not when setting up handlers for new parts
function cleanupPauseResumeHandlers(
  downloadID: string,
  finalCleanup: boolean = true
) {
  // Remove handlers - removeHandler doesn't throw if handler doesn't exist
  ipcMain.removeHandler(`ddl:${downloadID}:pause`);
  ipcMain.removeHandler(`ddl:${downloadID}:resume`);
  // Note: Don't remove abort handler here since it's managed globally
  // Always clear the current context to avoid stale references
  downloadContexts.delete(downloadID);
  if (finalCleanup) {
    downloadStates.delete(downloadID);
  }
  console.log(
    'Cleaned up pause/resume handlers',
    finalCleanup ? 'and states' : '(context only)',
    'for ID:',
    downloadID
  );
}

// Helper function to setup file stream with error handling
function setupFileStream(filePath: string, startByte: number): fs.WriteStream {
  // Ensure directory exists
  fs.mkdirSync(dirname(filePath), {
    recursive: true,
  });

  // When resuming, write from the exact byte offset rather than forcing append
  if (startByte > 0) {
    return fs.createWriteStream(filePath, { flags: 'r+', start: startByte });
  }
  return fs.createWriteStream(filePath);
}

// Helper function to determine file size from response
function getFileSizeFromResponse(
  response: AxiosResponse<Readable>,
  startByte: number
): number {
  const cl = response.headers['content-length'];
  let contentLength = cl ? parseInt(cl as any, 10) : NaN;
  let totalSize = contentLength;

  // Handle partial content response
  if (response.status === 206 && response.headers['content-range']) {
    const range = response.headers['content-range'];
    const match = range.match(/bytes \d+-\d+\/(\d+)/);
    if (match) {
      totalSize = parseInt(match[1], 10);
      console.log(
        `Partial content response, total size: ${totalSize}, content length: ${contentLength}`
      );
    }
  } else if (startByte > 0) {
    // Server doesn't support range requests, we need to restart from beginning
    console.log('Server does not support range requests, restarting download');
    totalSize = contentLength;
  } else {
    totalSize = contentLength;
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

      // Store unified download state for pause/resume functionality (works for both single and multi-part)
      downloadStates.set(downloadID, {
        downloadID,
        mainWindow,
        args,
        currentPart: 0,
        totalParts: args.length,
        headersAdditional: {},
        taskFinisher: () => {},
        isPaused: false,
        completedParts: new Set(),
      });
      console.log(
        'Created download state for ID:',
        downloadID,
        'with',
        args.length,
        'parts'
      );

      // Enqueue the download in the global DOWNLOAD_QUEUE
      const { initialPosition, wait, finish, cancelHandler } =
        DOWNLOAD_QUEUE.enqueue(downloadID, {
          type: 'direct',
        });

      // Update download state with the actual taskFinisher
      const downloadState = downloadStates.get(downloadID);
      if (downloadState) {
        downloadState.taskFinisher = finish;
      }

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

          // Clean up multi-part download state if it exists
          downloadStates.delete(downloadID);
          console.log('Deleted download state for ID:', downloadID);

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

            // Update download state with current part
            const downloadState = downloadStates.get(downloadID);
            if (downloadState) {
              downloadState.currentPart = parts;
              console.log(
                `Updated download state: part ${parts}/${downloadState.totalParts} for ID: ${downloadID}`
              );
            } else {
              console.error(
                `CRITICAL: No download state found for part ${parts} of download ${downloadID}`
              );
            }

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

            // Mark this part as completed in download state
            if (downloadState) {
              downloadState.completedParts.add(parts);
            }
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
