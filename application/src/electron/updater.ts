import axios from "axios";
import { app, BrowserWindow, net } from "electron";
import { createWriteStream, existsSync, readFileSync } from "original-fs";
import { __dirname } from "./main.js";
import { basename, join } from 'path';
import { spawn } from 'child_process';
function isDev() {
  return !app.isPackaged;
}

const filesToBackup = [ ]

function correctParsingSize(size: number) {
  if (size < 1024) {
    return size + "B";
  } else if (size < 1024 * 1024) {
    return (size / 1024).toFixed(2) + "KB";
  } else if (size < 1024 * 1024 * 1024) {
    return (size / (1024 * 1024)).toFixed(2) + "MB";
  } else {
    return (size / (1024 * 1024 * 1024)).toFixed(2) + "GB";
  }
}
export function checkIfInstallerUpdateAvailable() {
  return new Promise<void>(async (resolve) => {
    if (!net.isOnline()) {
      console.error("[updater] No internet connection available.");
      resolve();
      return;
    }

    // check dirname of self
    if (basename(__dirname) !== 'update') {
      console.log("[updater] Running portably, skipping update check.");
      console.log(`[updater] Current directory: ${basename(__dirname)}`);
      resolve();
      return;
    }

    const localVersion = existsSync(`${__dirname}/../updater-version.txt`) ? readFileSync(`${__dirname}/../updater-version.txt`, 'utf8') || '0.0.0' : '0.0.0';
    console.log(`[updater] Local version: ${localVersion}`);
    // check for updates
    try {
      const gitRepo = 'nat3z/OpenGameInstaller'
      const releases = await axios.get(`https://api.github.com/repos/${gitRepo}/releases`);

      const latestRelease = releases.data[0];
      const latestVersion = latestRelease.tag_name;
      let latestSetupVersionUrl: string | undefined = undefined;
      if (process.platform === 'win32') {
        latestSetupVersionUrl = latestRelease.assets.find((asset: { name: string }) => asset.name.includes('-Setup.exe'))?.browser_download_url;
      }
      else if (process.platform === 'linux') {
        latestSetupVersionUrl = latestRelease.assets.find((asset: { name: string }) => asset.name.includes('-Setup.AppImage'))?.browser_download_url;
      }
      if (!latestSetupVersionUrl) {
        console.error("[updater] No setup version found for the current platform.");
        resolve();
        return;
      }
      console.log(`[updater] Latest setup version url: ${latestSetupVersionUrl}`);
      // get the latest version of the setup from the description of the release
      const latestVersionResults = latestRelease.body.match(/Setup Version: (.*)/);
      if (!latestVersionResults || latestVersionResults.length < 2) {
        console.error("[updater] No setup version found in the release description.");
        resolve();
        return;
      }
      const latestSetupVersion = latestVersionResults[1];
      console.log(`[updater] Latest setup version: ${latestSetupVersion}`);
      console.log(`[updater] Latest version: ${latestVersion}`);

      if (latestSetupVersion !== localVersion) {
        console.log(`[updater] New version available: ${latestVersion}`);

        let mainWindow = new BrowserWindow({
          width: 300,
          height: 400,
          frame: false,
          webPreferences: {
            preload: isDev() ? join(app.getAppPath(), 'updater-preload.mjs') : join(app.getAppPath(), 'build/updater-preload.mjs'),
            nodeIntegration: true,
            devTools: false,
            contextIsolation: true,
          },
        });
        mainWindow.loadURL("file://" + join(app.getAppPath(), 'public', 'updater.html'));

        mainWindow.webContents.send('text', 'Downloading latest Setup...')
        // download the latest setup
        const response = await axios.get(latestSetupVersionUrl, { responseType: 'stream' });
        const writer = createWriteStream(`./setup-ogi.exe`);
        response.data.pipe(writer);
          const startTime = Date.now();
          const fileSize = response.headers['content-length'];
          response.data.on('data', () => {
            const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
            const downloadSpeed = response.data.socket.bytesRead / elapsedTime;
            mainWindow.webContents.send('text', 'Downloading Update', writer.bytesWritten, fileSize, correctParsingSize(downloadSpeed) + '/s');
          });
        writer.on('finish', () => {
          mainWindow.webContents.send('text', 'Launching Updater...')
          console.log(`[updater] Setup downloaded successfully.`);
          console.log(`[updater] Backing up files in update.`);
          writer.close();

          setTimeout(() => {
            spawn(`./setup-ogi.exe`, {
              detached: true,
              stdio: 'ignore'
            }).unref(); 
            mainWindow.close();
            resolve();
            process.exit(0); 
          }, 500);
          
        });

      }
    } catch (ex) {
      console.error("[updater] Error while checking for updates: ", ex);
      resolve();
    }
  }) 

}