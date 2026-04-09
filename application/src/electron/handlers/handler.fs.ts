import { dialog, ipcMain, shell } from 'electron';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { join } from 'path';
import * as fs from 'fs';
import { sendIPCMessage } from '@/electron/main.js';
import * as fsAsync from 'fs/promises';
import { extraction } from 'ogi-addon';

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

    console.log('Extracting RAR file: ', rarFilePath);
    console.log('Output directory: ', outputDir);

    // Send initial log to frontend if downloadId is provided
    if (downloadId) {
      sendIPCMessage('setup:log', {
        id: downloadId,
        log: ['Starting RAR extraction...'],
      });
    }
    if (downloadId) {
      sendIPCMessage('setup:log', {
        id: downloadId,
        log: ['Using ogi-addon extraction helper...'],
      });
    }

    try {
      await extraction(rarFilePath, outputDir);
      if (downloadId) {
        sendIPCMessage('setup:log', {
          id: downloadId,
          log: ['RAR extraction completed successfully'],
        });
      }
    } catch (error) {
      console.error(error);
      if (downloadId) {
        const message =
          error instanceof Error ? error.message : 'Unknown extraction error';
        sendIPCMessage('setup:log', {
          id: downloadId,
          log: [`RAR extraction failed: ${message}`],
        });
      }
      throw error;
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

        console.log('Extracting ZIP file: ', zipFilePath);
        console.log('Output directory: ', outputDir);

        // Send initial log to frontend if downloadId is provided
        if (downloadId) {
          sendIPCMessage('setup:log', {
            id: downloadId,
            log: ['Starting ZIP extraction...'],
          });
        }

        if (downloadId) {
          sendIPCMessage('setup:log', {
            id: downloadId,
            log: ['Using ogi-addon extraction helper...'],
          });
        }

        await extraction(zipFilePath, outputDir);
        if (downloadId) {
          sendIPCMessage('setup:log', {
            id: downloadId,
            log: ['ZIP extraction completed successfully'],
          });
        }

        return outputDir;
      } catch (err) {
        console.error(err);
        return null;
      }
    }
  );
}
