import { dialog, ipcMain, shell } from 'electron';
import { __dirname } from '../paths.js';
import { join } from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

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
    return result.filePaths[0];
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

  ipcMain.on('fs:delete', (event, arg) => {
    if (String(arg).startsWith('./')) {
      arg = join(__dirname, arg);
    }
    try {
      fs.unlinkSync(arg);
      event.returnValue = 'success';
    } catch (err) {
      event.returnValue = err;
      console.error(err);
    }
  });
  ipcMain.handle('fs:extract-rar', async (_, arg) => {
    const { rarFilePath, outputDir } = arg;

    if (!fs.existsSync(rarFilePath)) {
      throw new Error('RAR file does not exist');
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // use 7zip to extract the rar file or unrar if on linux
    console.log('Extracting RAR file: ', rarFilePath);
    console.log('Output directory: ', outputDir);
    if (process.platform === 'win32') {
      console.log('isWin32');
      let s7ZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';
      await new Promise<void>((resolve, reject) =>
        exec(
          `${s7ZipPath} x "${rarFilePath}" -o"${outputDir}"`,
          (err, stdout, stderr) => {
            if (err) {
              console.error(err);
              console.log(stderr);
              reject(new Error('Failed to extract RAR file'));
            }
            console.log(stdout);
            console.log(stderr);
            resolve();
          }
        )
      );
    }

    if (process.platform === 'linux' || process.platform === 'darwin') {
      console.log('isLinuxOrDarwin');
      await new Promise<void>((resolve) =>
        exec(
          `unrar x "${rarFilePath}" "${outputDir}"`,
          (error, stdout, stderr) => {
            if (error) {
              console.error(error);
              console.log(stderr);
              throw new Error('Failed to extract RAR file');
            }
            console.log(stdout);
            console.log(stderr);
            resolve();
          }
        )
      );
    }

    return outputDir;
  });
}
