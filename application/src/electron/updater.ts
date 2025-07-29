import axios from 'axios';
import { app, BrowserWindow, net } from 'electron';
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'original-fs';
import { basename, join } from 'path';
import { setTimeout as setTimeoutPromise } from 'timers/promises';
import { spawn } from 'child_process';
import * as path from 'path';

function isDev() {
  return !app.isPackaged;
}

const filesToBackup = ['config', 'addons', 'library', 'internals'];
let __dirname = isDev()
  ? app.getAppPath() + '/../'
  : path.dirname(process.execPath);
if (process.platform === 'linux') {
  // it's most likely sandboxed, so just use ./
  __dirname = './';
}

function correctParsingSize(size: number) {
  if (size < 1024) {
    return size + 'B';
  } else if (size < 1024 * 1024) {
    return (size / 1024).toFixed(2) + 'KB';
  } else if (size < 1024 * 1024 * 1024) {
    return (size / (1024 * 1024)).toFixed(2) + 'MB';
  } else {
    return (size / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
  }
}
export function checkIfInstallerUpdateAvailable() {
  return new Promise<void>(async (resolve) => {
    if (!net.isOnline()) {
      console.error('[updater] No internet connection available.');
      resolve();
      return;
    }

    // check dirname of self
    if (basename(__dirname) !== 'update' && process.platform !== 'linux') {
      console.log('[updater] Running portably, skipping update check.');
      console.log(`[updater] Current directory: ${basename(__dirname)}`);
      resolve();
      return;
    }

    if (process.platform === 'linux') {
      console.log(
        "[updater] Running on linux, most likely running the updater? let's just check to see if the thing exists."
      );
      if (!existsSync('../OpenGameInstaller-Setup.AppImage')) {
        console.error('[updater] No setup found, exiting.');
        resolve();
        return;
      }

      console.log('[updater] Setup found, continuing update process.');
    }

    const localVersion = existsSync(`${__dirname}/../updater-version.txt`)
      ? readFileSync(`${__dirname}/../updater-version.txt`, 'utf8') || '0.0.0'
      : '0.0.0';
    console.log(`[updater] Local version: ${localVersion}`);
    const bleedingEdge = existsSync(`${__dirname}/../bleeding-edge.txt`);
    // check for updates
    try {
      const gitRepo = 'nat3z/OpenGameInstaller';
      const releases = await axios.get(
        `https://api.github.com/repos/${gitRepo}/releases`
      );
      let latestRelease: any | undefined = undefined;
      for (const rel of releases.data) {
        if (!rel.body) continue;

        const latestVersionResults = rel.body.match(/Setup Version: (.*)/);
        if (!latestVersionResults || latestVersionResults.length < 2) {
          continue;
        }
        const latestSetupVersion = latestVersionResults[1];
        console.log(latestSetupVersion, localVersion);
        if (latestSetupVersion === localVersion) {
          break;
        }
        if (
          rel.prerelease &&
          bleedingEdge &&
          latestSetupVersion !== localVersion
        ) {
          latestRelease = rel;
          break;
        } else if (!rel.prerelease && latestSetupVersion !== localVersion) {
          latestRelease = rel;
          break;
        }
      }
      if (!latestRelease) {
        console.error('[updater] No new version available.');
        resolve();
        return;
      }
      let latestSetupVersionUrl: string | undefined = undefined;
      const latestVersion = latestRelease.tag_name;
      if (process.platform === 'win32') {
        latestSetupVersionUrl = latestRelease.assets.find(
          (asset: { name: string }) => asset.name.includes('-Setup.exe')
        )?.browser_download_url;
      } else if (process.platform === 'linux') {
        latestSetupVersionUrl = latestRelease.assets.find(
          (asset: { name: string }) => asset.name.includes('-Setup.AppImage')
        )?.browser_download_url;
      }
      if (!latestSetupVersionUrl) {
        console.error(
          '[updater] No setup version found for the current platform.'
        );
        resolve();
        return;
      }
      console.log(
        `[updater] Latest setup version url: ${latestSetupVersionUrl}`
      );
      // get the latest version of the setup from the description of the release
      const latestVersionResults =
        latestRelease.body.match(/Setup Version: (.*)/);
      if (!latestVersionResults || latestVersionResults.length < 2) {
        console.error(
          '[updater] No setup version found in the release description.'
        );
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
            preload: isDev()
              ? join(app.getAppPath(), 'updater-preload.mjs')
              : join(app.getAppPath(), 'build/updater-preload.mjs'),
            nodeIntegration: true,
            devTools: false,
            contextIsolation: true,
          },
        });
        mainWindow.loadURL(
          'file://' + join(app.getAppPath(), 'public', 'updater.html')
        );

        mainWindow.webContents.send('text', 'Downloading latest Setup...');
        // wait for the ETXTBSY error to go away
        // download the latest setup
        const response = await axios.get(latestSetupVersionUrl, {
          responseType: 'stream',
        });
        if (process.platform === 'win32') {
          const directory = app.getPath('temp') + '\\ogi-setup.exe';
          const writer = createWriteStream(directory);
          response.data.pipe(writer);
          const startTime = Date.now();
          const fileSize = response.headers['content-length'];
          response.data.on('data', () => {
            const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
            const downloadSpeed = response.data.socket.bytesRead / elapsedTime;
            mainWindow.webContents.send(
              'text',
              'Downloading Latest Setup',
              writer.bytesWritten,
              fileSize,
              correctParsingSize(downloadSpeed) + '/s'
            );
          });
          writer.on('finish', () => {
            mainWindow.webContents.send('text', 'Backing up Files');
            console.log(`[updater] Setup downloaded successfully.`);
            console.log(`[updater] Backing up files in update.`);
            writer.close();

            // now for each file in the update folder, copy it to a temporary folder
            const tempFolder = app.getPath('temp') + '/ogi-update-backup';
            if (!existsSync(tempFolder)) {
              mkdirSync(tempFolder);
            }
            for (const file of filesToBackup) {
              const source = join(__dirname, file);
              const destination = join(tempFolder, file);
              if (existsSync(source)) {
                console.log(`[updater] Copying ${source} to ${destination}`);
                mainWindow.webContents.send('text', 'Backing up files', source);
                cpSync(source, destination, { recursive: true });
              }
            }

            mainWindow.webContents.send('text', 'Starting Setup');

            setTimeout(() => {
              spawn(directory, {
                detached: true,
                stdio: 'ignore',
              }).unref();
              mainWindow.close();
              process.exit(0);
            }, 500);
          });
        } else if (process.platform === 'linux') {
          await setTimeoutPromise(3000);
          const writer = createWriteStream('../temp-setup-OGI.AppImage');
          response.data.pipe(writer);
          const startTime = Date.now();
          const fileSize = response.headers['content-length'];
          response.data.on('data', () => {
            const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
            const downloadSpeed = response.data.socket.bytesRead / elapsedTime;
            mainWindow.webContents.send(
              'text',
              'Downloading Latest Setup',
              writer.bytesWritten,
              fileSize,
              correctParsingSize(downloadSpeed) + '/s'
            );
          });
          writer.on('finish', () => {
            mainWindow.webContents.send('text', 'Backing up Files');
            console.log(`[updater] Setup downloaded successfully.`);
            console.log(`[updater] Backing up files in update.`);
            writer.close();

            // now for each file in the update folder, copy it to a temporary folder (since it's linux, we don't need to do this)
            const tempFolder = app.getPath('temp') + '/ogi-update-backup';
            if (!existsSync(tempFolder)) {
              mkdirSync(tempFolder);
            }

            for (const file of filesToBackup) {
              const source = join(__dirname, file);
              const destination = join(tempFolder, file);
              if (existsSync(source)) {
                console.log(`[updater] Copying ${source} to ${destination}`);
                mainWindow.webContents.send('text', 'Backing up files', source);
                cpSync(source, destination, { recursive: true });
              }
            }

            mainWindow.webContents.send('text', 'Starting Setup');

            setTimeout(async () => {
              // rename the temp-setup-OGI.AppImage to the OpenGameInstaller-Setup.AppImage
              console.log(
                `[updater] Renaming setup to OpenGameInstaller-Setup.AppImage`
              );
              rmSync('../OpenGameInstaller-Setup.AppImage', { force: true });
              console.log(
                `[updater] Moving over setup to OpenGameInstaller-Setup.AppImage`
              );
              cpSync(
                '../temp-setup-OGI.AppImage',
                '../OpenGameInstaller-Setup.AppImage'
              );
              rmSync('../temp-setup-OGI.AppImage', { force: true });
              console.log(
                `[updater] Copied setup to OpenGameInstaller-Setup.AppImage`
              );

              // set item +x permissions
              chmodSync('../OpenGameInstaller-Setup.AppImage', 0o755);
              mainWindow.webContents.send(
                'text',
                'Shutting Down OpenGameInstaller',
                'Please open OpenGameInstaller again'
              );
              await setTimeoutPromise(3000);
              mainWindow.close();
              process.exit(0);
            }, 500);
          });
        }
      } else {
        console.log(`[updater] No new version available.`);
        resolve();
      }
    } catch (ex) {
      console.error('[updater] Error while checking for updates: ', ex);
      resolve();
    }
  });
}
