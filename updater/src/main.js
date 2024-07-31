import { BrowserWindow, app, ipcMain } from 'electron';
import axios from 'axios';
import fs from 'fs';
import yauzl from 'yauzl';
import path from 'path';
let mainWindow;
const __dirname = app.getAppPath();

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
      preload: `${__dirname}/src/preload.mjs`,
      nodeIntegration: true,
      contextIsolation: true,
    },
  });
  mainWindow.loadURL(`file://${__dirname}/public/index.html`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // check for updates
  const gitRepo = "Nat3z/OpenGameInstaller"
  // check the github releases 
  const response = await axios.get(`https://api.github.com/repos/${gitRepo}/releases`);
  mainWindow.webContents.send('text', 'Checking for Updates');
  // if the version is different, download the new version
  let release;
  for (const rel of response.data) {
    if (rel.prerelease && usingBleedingEdge && response.data.tag_name !== localVersion) {
      release = rel;
      break;
    } else if (!rel.prerelease && !usingBleedingEdge && response.data.tag_name !== localVersion) {
      release = rel;
      break;
    }
  }
  mainWindow.webContents.send('text', 'No Updates Found');
  
  if (release) {
    // download the new version usinng axios stream
    const writer = fs.createWriteStream(`./update.zip`);
    mainWindow.webContents.send('text', 'Downloading Update');
    const response = await axios({
      url: release.assets[0].browser_download_url,
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
    });
  }
    
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
                        if (/\/$/.test(entry.fileName)) {
                            // Create the directory then read the next entry.
                            fs.mkdirSync(path.join(unzipToDir, entry.fileName), { recursive: true });
                            zipFile.readEntry();
                        }
                        // Files
                        else {
                            // Write the file to disk.
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
                          }
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