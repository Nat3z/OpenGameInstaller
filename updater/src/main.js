import { BrowserWindow, app, ipcMain, shell } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import yauzl from 'yauzl';
let mainWindow;

function isDev() {
  return !app.isPackaged;
}
const __dirname = isDev() ? app.getAppPath() : path.parse(app.getPath('exe')).dir;
process.noAsar = true;

function correctParsingSize(size) {
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
let localVersion = '0.0.0';
let usingBleedingEdge = false;
if (fs.existsSync(`./version.txt`)) {
  localVersion = fs.readFileSync(`./version.txt`, 'utf8');
}
if (fs.existsSync(`./bleeding-edge.txt`)) {
  usingBleedingEdge = true;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 300,
    height: 400,
    frame: false,
    webPreferences: {
      preload: `${app.getAppPath()}/src/preload.mjs`,
      nodeIntegration: true,
      contextIsolation: true,
    },
  });
  mainWindow.loadURL(`file://${app.getAppPath()}/public/index.html`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // disable opening devtools
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });
  // check for updates
  const gitRepo = "Nat3z/OpenGameInstaller"
  // check the github releases 
  const response = await axios.get(`https://api.github.com/repos/${gitRepo}/releases`);
  mainWindow.webContents.send('text', 'Checking for Updates');
  // if the version is different, download the new version
  let release;
  for (const rel of response.data) {
    console.log(rel.tag_name, localVersion);
    if (rel.tag_name === localVersion) {
      break;
    }
    if (rel.prerelease && usingBleedingEdge && rel.tag_name !== localVersion) {
      release = rel;
      break;
    } else if (!rel.prerelease && rel.tag_name !== localVersion) {
      release = rel;
      break;
    }
  }
  let updating = release !== undefined;
  if (release) {
    // download the new version usinng axios stream
    const writer = fs.createWriteStream(`./update.zip`);
    mainWindow.webContents.send('text', 'Downloading Update');
    const assetWithPortable = release.assets.find((asset) => asset.name.toLowerCase().includes('portable') || asset.name.toLowerCase().includes('portrable'));
    if (!assetWithPortable) {
      mainWindow.webContents.send('text', 'No Portable Version Found');
      return
    }
    const response = await axios({
      url: assetWithPortable.browser_download_url,
      method: 'GET',
      responseType: 'stream',
    });
    response.data.pipe(writer);
    const startTime = Date.now();
    const fileSize = response.headers['content-length'];
    response.data.on('data', () => {
      const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
      const downloadSpeed = response.data.socket.bytesRead / elapsedTime;
      mainWindow.webContents.send('text', 'Downloading Update', writer.bytesWritten, fileSize, correctParsingSize(downloadSpeed) + '/s');
    });
    response.data.on('end', async () => {
      mainWindow.webContents.send('text', 'Download Complete');
      // extract the zip file
      const prefix = __dirname + "/update";
      if (!fs.existsSync(prefix)) {
        fs.mkdirSync(prefix);
      }
      await new Promise(async (resolve, reject) => {
        mainWindow.webContents.send('text', 'Extracting Update');
        await unzip(`./update.zip`, prefix);
        resolve();
      });
      // delete the zip file
      fs.unlinkSync(`./update.zip`);
      // update the version file
      fs.writeFileSync(`./version.txt`, release.tag_name);
      // restart the app
      console.log('App Ready.')

      mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
      launchApp();
    });
  }
  if (!updating)
    launchApp();
}

async function launchApp() {
  if (!fs.existsSync(path.join(__dirname, 'update', 'OpenGameInstaller.exe'))) {
    mainWindow.webContents.send('text', 'Installation not found');
    return;
  }
  const error = await shell.openPath(path.join(__dirname, 'update', 'OpenGameInstaller.exe'));
  if (error) {
    console.error(error);
    console.log('Error Launching OpenGameInstaller');
    mainWindow.webContents.send('text', 'Error Launching OpenGameInstaller');
  }
  else  
    app.quit();
}
app.on('ready', createWindow);
// taken from https://stackoverflow.com/questions/63932027/how-to-unzip-to-a-folder-using-yauzl
const unzip = (zipPath, unzipToDir) => {
    return new Promise((resolve, reject) => {
        try {
            // Create folder if not exists
            fs.mkdirSync(unzipToDir, { recursive: true });

            // Same as example we open the zip.
            yauzl.open(zipPath, { lazyEntries: true }, (err, zipFile) => {
                if (err) {
                    zipFile.close();
                    reject(err);
                    return;
                }

                // This is the key. We start by reading the first entry.
                zipFile.readEntry();

                // Now for every entry, we will write a file or dir 
                // to disk. Then call zipFile.readEntry() again to
                // trigger the next cycle.
                zipFile.on('entry', (entry) => {
                    try {
                        // Directories
                        console.log(entry.fileName);
                        if (/(.*)\/(?:.*?)$/.test(entry.fileName)) {
                            const dirToMake = /(.*)\/(?:.*?)$/.exec(entry.fileName)[1];
                            // Create the directory then read the next entry.
                            console.log('Creating directory:', dirToMake);
                            fs.mkdirSync(path.join(unzipToDir, dirToMake), { recursive: true });
                        }
                        // check if entry is a directory
                        if (/\/$/.test(entry.fileName)) {
                            zipFile.readEntry();
                            return;
                        }
                        // Files
                        zipFile.openReadStream(entry, (readErr, readStream) => {
                            if (readErr) {
                                zipFile.close();
                                reject(readErr);
                                return;
                            }

                            const file = fs.createWriteStream(path.join(unzipToDir, entry.fileName));
                            readStream.pipe(file);
                            file.on('finish', () => {
                                // Wait until the file is finished writing, then read the next entry.
                                // @ts-ignore: Typing for close() is wrong.
                                file.close(() => {
                                    zipFile.readEntry();
                                });

                                file.on('error', (err) => {
                                    zipFile.close();
                                    reject(err);
                                });
                            });
                      });
                    } catch (e) {
                      zipFile.close();
                      reject(e);
                    }
                });
                zipFile.on('end', (err) => {
                    resolve();
                });
                zipFile.on('error', (err) => {
                    zipFile.close();
                    reject(err);
                });
            });
        }
        catch (e) {
            reject(e);
        }
    });
}