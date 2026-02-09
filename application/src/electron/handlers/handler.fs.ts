import { dialog, ipcMain, shell } from 'electron';
import { __dirname } from '../manager/manager.paths.js';
import { join } from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { sendIPCMessage } from '../main.js';
import * as fsAsync from 'fs/promises';

export default function handler() {
  ipcMain.on('fs:read', (event, arg) => {
    if (String(arg).startsWith('./')) {
      arg = join(__dirname, arg);
    }
    fs.readFile(arg, 'utf-8', (err, data) => {
      if (err) {
        event.returnValue = err;
        console.error(err);
        return;
      }
      event.returnValue = data;
    });
  });

  ipcMain.on('fs:exists', (event, arg) => {
    if (String(arg).startsWith('./')) {
      arg = join(__dirname, arg);
    }
    fs.access(arg, (err) => {
      if (err) {
        event.returnValue = false;
        return;
      }
      event.returnValue = true;
    });
  });
  ipcMain.on('fs:write', (event, arg) => {
    if (String(arg.path).startsWith('./')) {
      arg.path = join(__dirname, arg.path);
    }
    fs.writeFile(arg.path, arg.data, (err) => {
      if (err) {
        event.returnValue = err;
        console.error(err);
        return;
      }
      event.returnValue = 'success';
    });
  });
  ipcMain.on('fs:mkdir', (event, arg) => {
    if (String(arg).startsWith('./')) {
      arg = join(__dirname, arg);
    }
    fs.mkdir(arg, { recursive: true }, (err) => {
      if (err) {
        event.returnValue = err;
        console.error(err);
        return;
      }
      event.returnValue = 'success';
    });
  });
  ipcMain.on('fs:show-file-loc', (event, path) => {
    if (String(path).startsWith('./')) {
      path = join(__dirname, path);
    }

    if (!fs.existsSync(path)) {
      event.returnValue = false;
      return;
    }
    shell.showItemInFolder(path);
    event.returnValue = true;
  });
  ipcMain.handle('fs:dialog:show-open-dialog', async (_, options) => {
    const result = await dialog.showOpenDialog(options);
    return result.filePaths;
  });
  ipcMain.handle('fs:dialog:show-save-dialog', async (_, options) => {
    const result = await dialog.showSaveDialog(options);
    return result.filePath;
  });

  ipcMain.handle('fs:get-files-in-dir', async (_, arg) => {
    if (String(arg).startsWith('./')) {
      arg = join(__dirname, arg);
    }
    const files = fs.readdirSync(arg);
    return files;
  });

  ipcMain.handle('fs:delete', async (_, arg) => {
    if (String(arg).startsWith('./')) {
      arg = join(__dirname, arg);
    }
    try {
      if (String(arg).startsWith('./')) {
        arg = join(__dirname, arg);
      }
      await fsAsync.rm(arg, { recursive: true, force: true });
      return 'success';
    } catch (err) {
      return err;
    }
  });
  ipcMain.handle(
    'fs:move',
    async (_, arg: { source: string; destination: string }) => {
      let { source, destination } = arg;
      if (String(source).startsWith('./')) {
        source = join(__dirname, source);
      }
      if (String(destination).startsWith('./')) {
        destination = join(__dirname, destination);
      }
      try {
        await fsAsync.rename(source, destination);
        return 'success';
      } catch (err) {
        console.error(err);
        return err;
      }
    }
  );
  ipcMain.on('fs:delete:sync', async (event, arg) => {
    try {
      if (String(arg).startsWith('./')) {
        arg = join(__dirname, arg);
      }
      await fsAsync.rm(arg, { recursive: true, force: true });
      event.returnValue = 'success';
    } catch (err) {
      console.error(err);
      event.returnValue = err;
    }
  });
  ipcMain.handle('fs:extract-rar', async (_, arg) => {
    const { rarFilePath, outputDir, downloadId } = arg;

    if (!fs.existsSync(rarFilePath)) {
      throw new Error('RAR file does not exist');
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // use 7zip to extract the rar file or unrar if on linux
    console.log('Extracting RAR file: ', rarFilePath);
    console.log('Output directory: ', outputDir);

    // Send initial log to frontend if downloadId is provided
    if (downloadId) {
      sendIPCMessage('setup:log', {
        id: downloadId,
        log: ['Starting RAR extraction...'],
      });
    }
    if (process.platform === 'win32') {
      console.log('isWin32');
      if (downloadId) {
        sendIPCMessage('setup:log', {
          id: downloadId,
          log: ['Using 7-Zip to extract RAR files...'],
        });
      }
      let s7ZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';
      await new Promise<void>((resolve, reject) =>
        exec(
          `${s7ZipPath} x "${rarFilePath}" -o"${outputDir}"`,
          (err, stdout, stderr) => {
            if (err) {
              console.error(err);
              console.log(stderr);
              if (downloadId) {
                sendIPCMessage('setup:log', {
                  id: downloadId,
                  log: [`RAR extraction failed: ${err.message}`],
                });
              }
              reject(new Error('Failed to extract RAR file'));
              return;
            }
            console.log(stdout);
            console.log(stderr);
            if (downloadId) {
              sendIPCMessage('setup:log', {
                id: downloadId,
                log: ['RAR extraction completed successfully'],
              });
            }
            resolve();
          }
        )
      );
    }

    if (process.platform === 'linux' || process.platform === 'darwin') {
      console.log('isLinuxOrDarwin');
      if (downloadId) {
        sendIPCMessage('setup:log', {
          id: downloadId,
          log: ['Using unrar to extract RAR files...'],
        });
      }
      await new Promise<void>((resolve, reject) => {
        const unrarProcess = spawn('unrar', [
          'x',
          '-y',
          rarFilePath,
          outputDir,
        ]);

        unrarProcess.stdout.on('data', (data) => {
          console.log(`[unrar stdout]: ${data}`);
          if (downloadId) {
            const logMessage = data.toString().trim();
            if (logMessage) {
              sendIPCMessage('setup:log', {
                id: downloadId,
                log: [logMessage],
              });
            }
          }
        });

        unrarProcess.stderr.on('data', (data) => {
          console.error(`[unrar stderr]: ${data}`);
          if (downloadId) {
            const logMessage = data.toString().trim();
            if (logMessage) {
              sendIPCMessage('setup:log', {
                id: downloadId,
                log: [logMessage],
              });
            }
          }
        });

        unrarProcess.on('close', (code) => {
          if (code !== 0) {
            console.error(`unrar process exited with code ${code}`);
            if (downloadId) {
              sendIPCMessage('setup:log', {
                id: downloadId,
                log: [`Unrar process failed with exit code ${code}`],
              });
            }
            reject(new Error(`Unrar process failed with exit code ${code}`));
            return;
          }
          if (downloadId) {
            sendIPCMessage('setup:log', {
              id: downloadId,
              log: ['RAR extraction completed successfully'],
            });
          }
          resolve();
        });
      });
      console.log('done');
    }

    return outputDir;
  });

  ipcMain.on('fs:stat', async (event, arg: { path: string }) => {
    let stat = fs.statSync(arg.path);
    event.returnValue = {
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink(),
      isBlockDevice: stat.isBlockDevice(),
      isCharacterDevice: stat.isCharacterDevice(),
      isFIFO: stat.isFIFO(),
      isSocket: stat.isSocket(),
    };
  });

  ipcMain.handle(
    'fs:extract-zip',
    async (
      _,
      arg: { zipFilePath: string; outputDir: string; downloadId?: string }
    ) => {
      try {
        const { zipFilePath, outputDir, downloadId } = arg;

        if (!fs.existsSync(zipFilePath)) {
          throw new Error('ZIP file does not exist');
        }

        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        // use 7zip to extract the zip file or unzip if on linux/mac
        console.log('Extracting ZIP file: ', zipFilePath);
        console.log('Output directory: ', outputDir);

        // Send initial log to frontend if downloadId is provided
        if (downloadId) {
          sendIPCMessage('setup:log', {
            id: downloadId,
            log: ['Starting ZIP extraction...'],
          });
        }

        if (process.platform === 'win32') {
          console.log('isWin32');
          if (downloadId) {
            sendIPCMessage('setup:log', {
              id: downloadId,
              log: ['Using 7-Zip to extract files...'],
            });
          }
          let s7ZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';
          await new Promise<void>((resolve, reject) =>
            exec(
              `${s7ZipPath} x "${zipFilePath}" -o"${outputDir}"`,
              (err, stdout, stderr) => {
                if (err) {
                  console.error(err);
                  console.log(stderr);
                  if (downloadId) {
                    sendIPCMessage('setup:log', {
                      id: downloadId,
                      log: [`Extraction failed: ${err.message}`],
                    });
                  }
                  reject(new Error('Failed to extract ZIP file'));
                  return;
                }
                console.log(stdout);
                console.log(stderr);
                if (downloadId) {
                  sendIPCMessage('setup:log', {
                    id: downloadId,
                    log: ['ZIP extraction completed successfully'],
                  });
                }
                resolve();
              }
            )
          );
        }

        if (process.platform === 'linux' || process.platform === 'darwin') {
          console.log('isLinuxOrDarwin');
          if (downloadId) {
            sendIPCMessage('setup:log', {
              id: downloadId,
              log: ['Using unzip to extract files...'],
            });
          }
          await new Promise<void>((resolve, reject) => {
            // create the output directory if it doesn't exist
            if (!fs.existsSync(outputDir)) {
              fs.mkdirSync(outputDir, { recursive: true });
            }

            const unzipProcess = spawn(
              'unzip',
              [
                '-o', // overwrite files without prompting
                zipFilePath,
                '-d', // specify output directory
                outputDir,
              ],
              {
                env: {
                  ...process.env,
                  UNZIP_DISABLE_ZIPBOMB_DETECTION: 'TRUE',
                },
              }
            );

            unzipProcess.stdout.on('data', (data) => {
              console.log(`[unzip stdout]: ${data}`);
              if (downloadId) {
                const logMessage = data.toString().trim();
                if (logMessage) {
                  sendIPCMessage('setup:log', {
                    id: downloadId,
                    log: [logMessage],
                  });
                }
              }
            });

            unzipProcess.stderr.on('data', (data) => {
              console.error(`[unzip stderr]: ${data}`);
              if (downloadId) {
                const logMessage = data.toString().trim();
                if (logMessage) {
                  sendIPCMessage('setup:log', {
                    id: downloadId,
                    log: [logMessage],
                  });
                }
              }
            });

            unzipProcess.on('close', (code) => {
              if (code !== 0) {
                console.error(`unzip process exited with code ${code}`);
                if (downloadId) {
                  sendIPCMessage('setup:log', {
                    id: downloadId,
                    log: [`Unzip process failed with exit code ${code}`],
                  });
                }
                reject(new Error('Failed to extract ZIP file'));
                return;
              }
              if (downloadId) {
                sendIPCMessage('setup:log', {
                  id: downloadId,
                  log: ['ZIP extraction completed successfully'],
                });
              }
              resolve();
            });
          });
          console.log('done');
        }

        return outputDir;
      } catch (err) {
        console.error(err);
        return null;
      }
    }
  );
}
