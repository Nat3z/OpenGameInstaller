import { BrowserWindow, app, dialog, net } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path, { join } from 'path';
import yauzl from 'yauzl';
import zlib from 'zlib';
import { spawn, exec } from 'child_process';
let mainWindow;
import pjson from '../package.json' with { type: 'json' };

function isDev() {
  return !app.isPackaged;
}

let __dirname = isDev()
  ? app.getAppPath() + '/'
  : path.dirname(process.execPath);
if (process.platform === 'linux') {
  // it's most likely sandboxed, so just use ./
  __dirname = './';
}
console.log(__dirname);
const SETUP_VERSION = pjson.version;
fs.writeFile(join(__dirname, 'updater-version.txt'), SETUP_VERSION, () => {
  console.log('Wrote version file');
});
process.noAsar = true;

function correctParsingSize(size) {
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

let localVersion = '0.0.0';
let usingBleedingEdge = false;
if (fs.existsSync(`./version.txt`)) {
  localVersion = fs.readFileSync(`./version.txt`, 'utf8');
}
if (fs.existsSync(`./bleeding-edge.txt`)) {
  usingBleedingEdge = true;
}

/**
 * Create and display the updater window, ensure no other instance is running, and handle update checking, download, installation, and app launch.
 *
 * This function:
 * - Verifies that no other instance is serving on localhost:7654 and exits if one is found.
 * - Creates the frameless updater BrowserWindow and prevents DevTools from opening.
 * - If the device is offline, notifies the UI and launches OpenGameInstaller in offline mode.
 * - When online, queries GitHub Releases for a newer release (respecting bleeding-edge prerelease selection), and either:
 *   - Uses a cached release if present and valid, copying files into ./update and writing ./version.txt, or
 *   - Downloads the appropriate platform asset, reports progress to the UI, extracts or places files into ./update (and a temp cache), writes ./version.txt, adjusts execution permissions on Linux, and then launches OpenGameInstaller.
 * - Falls back to launching the existing installed version if update operations fail or no update is found.
 *
 * Side effects:
 * - Creates and writes files under the app directory (e.g., ./update, ./version.txt) and the OS temp directory for caches.
 * - May spawn the OpenGameInstaller process and exit the host app.
 * - Sends status messages to the renderer via mainWindow.webContents.send.
 */
async function createWindow() {
  // check if port 7654 is open, if not, start the server
  try {
    const port_check = await fetch('http://localhost:7654');
    if (port_check.ok) {
      console.error(
        'Port 7654 is already in use, meaning OpenGameInstaller is already running. Exiting.'
      );
      dialog.showErrorBox(
        'OpenGameInstaller is already running',
        'OpenGameInstaller is already running. Please close the other instance before launching OpenGameInstaller again.'
      );
      app.exit(1);
    }
  } catch {
    console.log("Port isn't in use! Launching....");
  }

  mainWindow = new BrowserWindow({
    width: 300,
    height: 400,
    frame: false,
    resizable: false,
    webPreferences: {
      preload: `${app.getAppPath()}/src/preload.mjs`,
      nodeIntegration: true,
      devTools: false,
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

  // Check if device is offline - skip update check entirely if offline
  if (!net.isOnline()) {
    console.log('Device is offline, skipping update check');
    mainWindow.webContents.send(
      'text',
      'Launching OpenGameInstaller',
      'Offline Mode'
    );
    launchApp(false);
    return;
  }

  // check for updates
  const gitRepo = 'Nat3z/OpenGameInstaller';

  // check the github releases
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${gitRepo}/releases`,
      { timeout: 10000 } // 10 second timeout for update check
    );
    mainWindow.webContents.send('text', 'Checking for Updates');
    const releases = response.data
      .filter((rel) => (usingBleedingEdge ? rel.prerelease : !rel.prerelease))
      .sort(
        (a, b) =>
          new Date(b.published_at || b.created_at || 0).getTime() -
          new Date(a.published_at || a.created_at || 0).getTime()
      );
    const localIndex = releases.findIndex(
      (rel) => rel.tag_name === localVersion
    );
    const targetRelease = releases[0];
    let updating = Boolean(targetRelease) && localIndex !== 0;
    if (targetRelease && updating) {
      const releasePath =
        localIndex > 0
          ? releases.slice(0, localIndex).reverse()
          : [targetRelease];
      const gap =
        localIndex > 0 ? releasePath.length : Number.POSITIVE_INFINITY;
      let updateApplied = false;

      if (Number.isFinite(gap) && gap > 0 && gap <= 3) {
        mainWindow.webContents.send(
          'text',
          'Preparing incremental update path'
        );
        try {
          await applyBlockmapPath(releasePath, releases);
          updateApplied = true;
        } catch (patchErr) {
          console.error('Incremental patching failed, falling back:', patchErr);
          mainWindow.webContents.send(
            'text',
            'Falling back to full download',
            patchErr.message
          );
        }
      } else if (!Number.isFinite(gap)) {
        mainWindow.webContents.send(
          'text',
          'Falling back to full download',
          'Local version missing from release feed'
        );
      } else {
        mainWindow.webContents.send(
          'text',
          'Falling back to full download',
          'Version too old for incremental update'
        );
      }

      if (!updateApplied) {
        await downloadFullRelease(targetRelease);
      }
      fs.writeFileSync(`./version.txt`, targetRelease.tag_name);
      mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
      launchApp(true);
      return;
    }
    if (!updating) {
      mainWindow.webContents.send(
        'text',
        'Launching OpenGameInstaller',
        'No Updates Found'
      );
      // check if the user is offline
      launchApp(net.isOnline());
    }
  } catch (e) {
    console.error(e);
    mainWindow.webContents.send(
      'text',
      'Launching OpenGameInstaller',
      'Failed to check for updates'
    );
    // check if the user is offline
    launchApp(net.isOnline());
  }
}

function getVersionCache(tagName) {
  return path.join(
    app.getPath('temp'),
    `ogi-${tagName.replace('v', '')}-cache`
  );
}

function getPlatformAsset(release) {
  if (process.platform === 'win32') {
    return release.assets.find(
      (asset) =>
        asset.name.toLowerCase().includes('portable') ||
        asset.name.toLowerCase().includes('portrable')
    );
  }
  return release.assets.find((asset) =>
    asset.name.toLowerCase().includes('linux-pt.appimage')
  );
}

function getBlockmapAsset(release, targetAsset) {
  return release.assets.find(
    (asset) =>
      asset.name.toLowerCase() === `${targetAsset.name.toLowerCase()}.blockmap`
  );
}

function getReleaseByTag(releases, tagName) {
  return releases.find((release) => release.tag_name === tagName);
}

async function ensureCachedSourceArtifact(cacheDir, release, asset) {
  const sourceArtifactPath = path.join(cacheDir, asset.name);
  if (fs.existsSync(sourceArtifactPath)) {
    return sourceArtifactPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  // On Linux we usually have the currently installed AppImage available locally.
  if (process.platform === 'linux') {
    const installedAppImage = path.join(
      __dirname,
      'update',
      'OpenGameInstaller.AppImage'
    );
    if (fs.existsSync(installedAppImage)) {
      fs.copyFileSync(installedAppImage, sourceArtifactPath);
      return sourceArtifactPath;
    }
  }

  await downloadToFile(
    asset.browser_download_url,
    sourceArtifactPath,
    `Downloading base artifact ${release.tag_name}`
  );
  return sourceArtifactPath;
}

async function ensureCachedBlockmap(cacheDir, release, asset) {
  const blockmapAsset = getBlockmapAsset(release, asset);
  if (!blockmapAsset) {
    throw new Error(`Blockmap missing for ${release.tag_name}`);
  }

  const blockmapPath = path.join(cacheDir, `${asset.name}.blockmap`);
  if (fs.existsSync(blockmapPath)) {
    return blockmapPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  await downloadToFile(
    blockmapAsset.browser_download_url,
    blockmapPath,
    `Downloading blockmap ${release.tag_name}`
  );
  return blockmapPath;
}

async function downloadToFile(url, destination, status) {
  const writer = fs.createWriteStream(destination);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  const startTime = Date.now();
  const fileSize = response.headers['content-length'];
  response.data.on('data', () => {
    const elapsedTime = (Date.now() - startTime) / 1000;
    const downloadSpeed =
      response.data.socket.bytesRead / Math.max(elapsedTime, 1);
    mainWindow.webContents.send(
      'text',
      status,
      writer.bytesWritten,
      fileSize,
      correctParsingSize(downloadSpeed) + '/s'
    );
  });
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });
}

function copyCacheToUpdate(cacheDir) {
  const files = fs.readdirSync(cacheDir);
  const destRoot = path.join(__dirname, 'update');
  fs.mkdirSync(destRoot, { recursive: true });
  for (const file of files) {
    fs.cpSync(path.join(cacheDir, file), path.join(destRoot, file), {
      force: true,
      recursive: true,
    });
  }
}

async function downloadFullRelease(release) {
  const assetWithPortable = getPlatformAsset(release);
  if (!assetWithPortable) {
    throw new Error('No portable asset found for this platform');
  }
  const localCache = getVersionCache(release.tag_name);
  fs.mkdirSync(localCache, { recursive: true });
  const blockmapAsset = getBlockmapAsset(release, assetWithPortable);

  mainWindow.webContents.send('text', 'Downloading Update');
  const downloadPath =
    process.platform === 'win32'
      ? './update.zip'
      : './update/OpenGameInstaller.AppImage';
  if (process.platform === 'linux') {
    fs.mkdirSync('./update', { recursive: true });
  }
  await downloadToFile(
    assetWithPortable.browser_download_url,
    downloadPath,
    'Downloading Update'
  );
  if (blockmapAsset) {
    await downloadToFile(
      blockmapAsset.browser_download_url,
      path.join(localCache, `${assetWithPortable.name}.blockmap`),
      'Downloading blockmap'
    );
  }
  mainWindow.webContents.send('text', 'Download Complete');

  if (process.platform === 'win32') {
    mainWindow.webContents.send('text', 'Extracting Update');
    await unzip(`./update.zip`, localCache);
    mainWindow.webContents.send('text', 'Copying Update Files');
    copyCacheToUpdate(localCache);
    fs.copyFileSync(
      './update.zip',
      path.join(localCache, assetWithPortable.name)
    );
    fs.unlinkSync('./update.zip');
  } else {
    const item = path.join(__dirname, 'update', 'OpenGameInstaller.AppImage');
    fs.copyFileSync(item, path.join(localCache, 'OpenGameInstaller.AppImage'));
    fs.copyFileSync(item, path.join(localCache, assetWithPortable.name));
    fs.chmodSync(item, '755');
  }
}

async function applyBlockmapPath(releasePath, releases) {
  let currentTag = localVersion;
  for (let i = 0; i < releasePath.length; i++) {
    const currentRelease = getReleaseByTag(releases, currentTag);
    const nextRelease = releasePath[i];
    mainWindow.webContents.send(
      'text',
      `Applying patch ${i + 1} of ${releasePath.length}`
    );
    if (!currentRelease) {
      throw new Error(`Release metadata missing for ${currentTag}`);
    }
    const fromCache = getVersionCache(currentTag);
    const nextCache = getVersionCache(nextRelease.tag_name);
    const currentAsset = getPlatformAsset(currentRelease);
    if (!currentAsset) {
      throw new Error(`Portable asset missing for ${currentTag}`);
    }
    const nextAsset = getPlatformAsset(nextRelease);
    if (!nextAsset) {
      throw new Error(`Portable asset missing for ${nextRelease.tag_name}`);
    }
    const newBlockmapAsset = getBlockmapAsset(nextRelease, nextAsset);
    if (!newBlockmapAsset) {
      throw new Error(`Blockmap missing for ${nextRelease.tag_name}`);
    }
    const sourceArtifact = await ensureCachedSourceArtifact(
      fromCache,
      currentRelease,
      currentAsset
    );
    const oldBlockmapPath = await ensureCachedBlockmap(
      fromCache,
      currentRelease,
      currentAsset
    );
    fs.mkdirSync(nextCache, { recursive: true });
    const newBlockmapPath = path.join(nextCache, `${nextAsset.name}.blockmap`);
    if (!fs.existsSync(newBlockmapPath)) {
      await downloadToFile(
        newBlockmapAsset.browser_download_url,
        newBlockmapPath,
        'Downloading blockmap'
      );
    }
    const outputArtifact = path.join(nextCache, nextAsset.name);
    await applyBlockmapPatch(
      sourceArtifact,
      oldBlockmapPath,
      outputArtifact,
      newBlockmapPath,
      nextAsset.browser_download_url
    );

    if (process.platform === 'win32') {
      await unzip(outputArtifact, nextCache);
    } else {
      fs.copyFileSync(
        outputArtifact,
        path.join(nextCache, 'OpenGameInstaller.AppImage')
      );
    }
    currentTag = nextRelease.tag_name;
  }
  copyCacheToUpdate(
    getVersionCache(releasePath[releasePath.length - 1].tag_name)
  );
  if (process.platform === 'linux') {
    fs.chmodSync('./update/OpenGameInstaller.AppImage', '755');
  }
}

async function applyBlockmapPatch(
  sourceArtifact,
  oldBlockmapPath,
  outputArtifact,
  newBlockmapPath,
  targetUrl
) {
  const oldMap = JSON.parse(zlib.gunzipSync(fs.readFileSync(oldBlockmapPath)));
  const newMap = JSON.parse(zlib.gunzipSync(fs.readFileSync(newBlockmapPath)));
  const oldFile = oldMap.files?.[0];
  const newFile = newMap.files?.[0];
  if (!oldFile || !newFile) {
    throw new Error('Invalid blockmap payload');
  }
  const checksumToBlocks = new Map();
  let oldOffset = oldFile.offset || 0;
  for (let i = 0; i < oldFile.checksums.length; i++) {
    const key = oldFile.checksums[i];
    const block = { offset: oldOffset, size: oldFile.sizes[i] };
    const current = checksumToBlocks.get(key) || [];
    current.push(block);
    checksumToBlocks.set(key, current);
    oldOffset += oldFile.sizes[i];
  }

  fs.mkdirSync(path.dirname(outputArtifact), { recursive: true });
  let sourceFd;
  let outFd;

  try {
    sourceFd = fs.openSync(sourceArtifact, 'r');
    outFd = fs.openSync(outputArtifact, 'w');
    let writeOffset = newFile.offset || 0;
    const misses = [];

    for (let i = 0; i < newFile.checksums.length; i++) {
      const size = newFile.sizes[i];
      const blocks = checksumToBlocks.get(newFile.checksums[i]);
      const matched = blocks?.shift();
      if (matched) {
        const buffer = Buffer.alloc(size);
        fs.readSync(sourceFd, buffer, 0, size, matched.offset);
        fs.writeSync(outFd, buffer, 0, size, writeOffset);
      } else {
        misses.push({ offset: writeOffset, size });
      }
      writeOffset += size;
    }

    const mergedMisses = [];
    for (const miss of misses) {
      const last = mergedMisses[mergedMisses.length - 1];
      if (last && last.offset + last.size === miss.offset) {
        last.size += miss.size;
      } else {
        mergedMisses.push({ ...miss });
      }
    }

    for (const miss of mergedMisses) {
      const end = miss.offset + miss.size - 1;
      const requestedRange = `bytes=${miss.offset}-${end}`;
      const rangeResponse = await axios({
        url: targetUrl,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: { Range: requestedRange },
      });

      const expectedSize = end - miss.offset + 1;
      const actualSize = Buffer.byteLength(rangeResponse.data);
      const contentRange = rangeResponse.headers['content-range'];
      const expectedContentRangePrefix = `bytes ${miss.offset}-${end}/`;

      if (rangeResponse.status !== 206) {
        throw new Error(
          `Invalid range response status ${rangeResponse.status} for ${requestedRange}`
        );
      }
      if (actualSize !== expectedSize || actualSize !== miss.size) {
        throw new Error(
          `Invalid range response length ${actualSize} for ${requestedRange}; expected ${expectedSize}`
        );
      }
      if (
        typeof contentRange !== 'string' ||
        !contentRange.startsWith(expectedContentRangePrefix)
      ) {
        throw new Error(
          `Invalid content-range header for ${requestedRange}: ${contentRange}`
        );
      }

      const chunk = Buffer.from(rangeResponse.data);
      fs.writeSync(outFd, chunk, 0, chunk.length, miss.offset);
    }
  } finally {
    if (typeof sourceFd === 'number') {
      try {
        fs.closeSync(sourceFd);
      } catch (closeErr) {
        console.error('Failed to close source file descriptor:', closeErr);
      }
    }
    if (typeof outFd === 'number') {
      try {
        fs.closeSync(outFd);
      } catch (closeErr) {
        console.error('Failed to close output file descriptor:', closeErr);
      }
    }
  }
  if (
    !fs.existsSync(outputArtifact) ||
    fs.statSync(outputArtifact).size === 0
  ) {
    throw new Error('Patched artifact is empty');
  }
}

/**
 * Launches the installed OpenGameInstaller, rotating logs, spawning the platform-specific executable in a detached process, and terminating the updater.
 *
 * Spawns OpenGameInstaller with `--online=<online>` as an argument.
 * @param {boolean} online - If true, start the application in online mode; otherwise start in offline mode.
 */
async function launchApp(online) {
  console.log('Launching in ' + (online ? 'online' : 'offline') + ' mode');
  mainWindow.webContents.send('text', 'Launching OpenGameInstaller');
  if (process.platform === 'win32') {
    if (
      !fs.existsSync(path.join(__dirname, 'update', 'OpenGameInstaller.exe'))
    ) {
      mainWindow.webContents.send(
        'text',
        'Installation not found',
        'Launch Failed'
      );
      return;
    }
    // OpenGameInstaller.exe logs will be written to latest.log in the update directory
    // if there's already a latest.log, move it to the logs/ fodler with the date and time in the name
    if (!fs.existsSync(path.join(__dirname, 'update', 'logs'))) {
      fs.mkdirSync(path.join(__dirname, 'update', 'logs'));
    }
    if (fs.existsSync(path.join(__dirname, 'update', 'latest.log'))) {
      const date = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(
        path.join(__dirname, 'update', 'latest.log'),
        path.join(__dirname, 'update', 'logs', date + '.log')
      );
    }

    const logStream = fs.openSync(
      path.join(__dirname, 'update', 'latest.log'),
      'a'
    );
    const spawned = spawn('./OpenGameInstaller.exe', ['--online=' + online], {
      cwd: path.join(__dirname, 'update'),
      detached: true,
      stdio: ['ignore', logStream, logStream],
    });
    spawned.unref();
    app.exit(0);
  } else if (process.platform === 'linux') {
    if (
      !fs.existsSync(
        path.join(__dirname, 'update', 'OpenGameInstaller.AppImage')
      )
    ) {
      mainWindow.webContents.send(
        'text',
        'Installation not found',
        'Launch Failed'
      );
      return;
    }
    setTimeout(() => {
      // OpenGameInstaller.AppImage logs will be written to latest.log in the update directory
      // if there's already a latest.log, move it to the logs/ fodler with the date and time in the name
      if (!fs.existsSync(path.join(__dirname, 'update', 'logs'))) {
        fs.mkdirSync(path.join(__dirname, 'update', 'logs'));
      }
      if (fs.existsSync(path.join(__dirname, 'update', 'latest.log'))) {
        const date = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(
          path.join(__dirname, 'update', 'latest.log'),
          path.join(__dirname, 'update', 'logs', date + '.log')
        );
      }
      const logStream = fs.openSync(
        path.join(__dirname, 'update', 'latest.log'),
        'a'
      );

      // --no-sandbox is needed to run the appimage in Steam Deck Game Mode
      const spawned = spawn(
        './OpenGameInstaller.AppImage',
        ['--online=' + online, '--no-sandbox'],
        {
          cwd: path.join(__dirname, 'update'),
          detached: true,
          stdio: ['ignore', logStream, logStream],
        }
      );
      spawned.unref();
      app.exit(0);
    }, 200);
  }
}
app.on('ready', createWindow);
// taken from https://stackoverflow.com/questions/63932027/how-to-unzip-to-a-folder-using-yauzl
const unzip = (zipPath, unzipToDir) => {
  return new Promise((resolve, reject) => {
    let zipFile = null;
    let filesProcessed = 0;
    let totalFiles = 0;

    try {
      // Create folder if not exists
      fs.mkdirSync(unzipToDir, { recursive: true });

      // Same as example we open the zip.
      yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
        if (err) {
          reject(err);
          return;
        }

        zipFile = zip;
        totalFiles = zipFile.entryCount;

        // This is the key. We start by reading the first entry.
        zipFile.readEntry();

        // Now for every entry, we will write a file or dir
        // to disk. Then call zipFile.readEntry() again to
        // trigger the next cycle.
        zipFile.on('entry', (entry) => {
          try {
            // Normalize path separators for Windows
            const normalizedFileName = entry.fileName.replace(/\//g, path.sep);
            const fullPath = path.join(unzipToDir, normalizedFileName);

            // Ensure the directory exists
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }

            // check if entry is a directory
            if (/\/$/.test(entry.fileName)) {
              filesProcessed++;
              if (filesProcessed >= totalFiles) {
                zipFile.close();
                resolve();
                return;
              }
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

              const file = fs.createWriteStream(fullPath);
              readStream.pipe(file);

              file.on('finish', () => {
                // Wait until the file is finished writing, then read the next entry.
                file.close((closeErr) => {
                  if (closeErr) {
                    zipFile.close();
                    reject(closeErr);
                    return;
                  }

                  filesProcessed++;
                  if (filesProcessed >= totalFiles) {
                    zipFile.close();
                    resolve();
                    return;
                  }
                  zipFile.readEntry();
                });
              });

              file.on('error', (fileErr) => {
                zipFile.close();
                reject(fileErr);
              });

              readStream.on('error', (streamErr) => {
                file.destroy();
                zipFile.close();
                reject(streamErr);
              });
            });
          } catch (e) {
            zipFile.close();
            reject(e);
          }
        });

        zipFile.on('end', () => {
          if (zipFile) {
            zipFile.close();
          }
          resolve();
        });

        zipFile.on('error', (zipErr) => {
          if (zipFile) {
            zipFile.close();
          }
          reject(zipErr);
        });
      });
    } catch (e) {
      if (zipFile) {
        zipFile.close();
      }
      reject(e);
    }
  });
};
