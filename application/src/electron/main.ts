import { join } from 'path';
import { server, port, clients } from "./server/addon-server.js"
import { applicationAddonSecret } from './server/constants.js';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from 'electron';
import fs, { ReadStream } from 'fs';
import { readFile } from 'fs/promises';
import RealDebrid from 'real-debrid-js';
import { exec } from 'child_process';
import { processes, setupAddon, startAddon } from './addon-init-configure.js';
import { isSecurityCheckEnabled } from './server/AddonConnection.js';
import os from 'os';
import axios from 'axios';
import { addTorrent, stopClient } from './webtorrent-connect.js';
import path from 'path';
import { QBittorrent } from '@ctrl/qbittorrent';
import { getStoredValue, refreshCached } from './config-util.js';
import * as JsSearch from 'js-search'
import { ConfigurationFile } from 'ogi-addon/build/config/ConfigurationBuilder.js';
import { LibraryInfo } from 'ogi-addon';
const VERSION = app.getVersion();

let __dirname = isDev() ? app.getAppPath() + "/../" : path.dirname(process.execPath);
if (process.platform === 'linux') {
    // it's most likely sandboxed, so just use ./
    __dirname = './';
}
let qbitClient: QBittorrent | undefined = undefined;
let torrentIntervals: NodeJS.Timeout[] = []
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow: BrowserWindow | null;
let realDebridClient = new RealDebrid({
    apiKey: 'UNSET'
}); 
function isDev() {
    return !app.isPackaged;
}
let steamApps: { appid: string, name: string }[] = [];
let steamAppSearcher = new JsSearch.Search('name');
steamAppSearcher.addIndex('name');

async function getSteamApps(): Promise<{ appid: string, name: string }[]> {
  if (fs.existsSync('steam-apps.json')) {
    const steamApps: { timeSinceUpdate: number, data: {appid: string, name: string}[] } = JSON.parse(fs.readFileSync('steam-apps.json', 'utf-8'));
    if (Date.now() - steamApps.timeSinceUpdate < 86400000) { //24 hours
      return steamApps.data;
    }
  }
  const response = await axios.get('https://api.steampowered.com/ISteamApps/GetAppList/v0002/?key=STEAMKEY&format=json') 
  const steamApps = response.data.applist.apps;
  fs.writeFileSync('steam-apps.json', JSON.stringify({ timeSinceUpdate: Date.now(), data: steamApps }, null, 2));
  return steamApps
}
// lazy tasks
new Promise<void>(async (resolve) => {
    steamApps = await getSteamApps();
    steamAppSearcher.addDocuments(steamApps);
    resolve();
});
interface Notification {
  message: string;
  id: string;
  type: 'info' | 'error' | 'success' | 'warning';
}
export function sendNotification(notification: Notification) {
    if (!mainWindow) {
        console.error('Main window is not ready yet. Cannot send notification.');
        return;
    }
    if (!mainWindow.webContents) {
        console.error('Main window web contents is not ready yet. Cannot send notification.');
        return;
    }
    mainWindow.webContents.send('notification', notification);
}

export let currentScreens = new Map<string, { [key: string]: string | boolean | number } | undefined>();

export function sendAskForInput(id: string, config: ConfigurationFile, name: string, description: string) {
    if (!mainWindow) {
        console.error('Main window is not ready yet. Cannot send ask for input.');
        return;
    }
    if (!mainWindow.webContents) {
        console.error('Main window web contents is not ready yet. Cannot send ask for input.');
        return;
    }
    mainWindow.webContents.send('input-asked', { id, config, name, description });
    currentScreens.set(id, undefined);
}

function createWindow() {    
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: true,
            preload: isDev() ? join(app.getAppPath(), 'preload.mjs') : join(app.getAppPath(), 'build/preload.mjs')
        },
        title: 'OpenGameInstaller',
        fullscreenable: false,
        resizable: false,
        icon: join(app.getAppPath(), 'public/favicon.ico'),
        autoHideMenuBar: true,
        show: false
    });

    // This block of code is intended for development purpose only.
    // Delete this entire block of code when you are ready to package the application.
    if (isDev()) {
        mainWindow!!.loadURL('http://localhost:8080/?secret=' + applicationAddonSecret);
        console.log('Running in development');
    } else {
        mainWindow!!.loadURL("file://" + join(app.getAppPath(), 'public', 'index.html') + "?secret=" + applicationAddonSecret);
    }
    
    // Uncomment the following line of code when app is ready to be packaged.
    // loadURL(mainWindow);

    // Open the DevTools and also disable Electron Security Warning.
    // process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = true;
    // mainWindow.webContents.openDevTools();

    // Emitted when the window is closed.
    mainWindow.on('closed', function () {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        mainWindow = null
    });

    // Emitted when the window is ready to be shown
    // This helps in showing the window gracefully.
    fs.mkdir("./config/", (_) => {});
    fs.mkdir("./config/option/", (_) => {});
    mainWindow.once('ready-to-show', () => {

        ipcMain.handle('app:close', () => {
            mainWindow?.close();
        });
        ipcMain.handle('app:minimize', () => {
            mainWindow?.minimize();
        });
        ipcMain.handle('app:axios', async (_, options) => {
            try {
                const response = await axios(options);
                return { data: response.data, status: response.status, success: response.status >= 200 && response.status < 300 };
            } catch (err) {
                return { data: err.response.data, status: err.response.status, success: false };
            }
        });

        ipcMain.handle('app:get-os', () => {
            return process.platform;
        });
        ipcMain.handle('app:search-id', async (_, query) => {
            const results = steamAppSearcher.search(query);
            return results;
        });
        ipcMain.handle('app:screen-input', async (_, data) => {
            currentScreens.set(data.id, data.data)
            return;
        });
        ipcMain.handle('app:launch-game', async (_, appid) => {
            if (!fs.existsSync('./library')) {
                return;
            }
            if (!fs.existsSync('./internals')) {
                fs.mkdirSync('./internals');
            }
            if (!fs.existsSync('./library/' + appid + '.json')) {
                return;
            }
            
            const appInfo: LibraryInfo = JSON.parse(fs.readFileSync('./library/' + appid + '.json', 'utf-8'));
            const args = appInfo.launchArguments ?? ''
            const spawnedItem = exec("\"" + appInfo.launchExecutable + "\" " + args, {
                cwd: appInfo.cwd
            })
            spawnedItem.on('error', (error) => {
                console.error(error);
                sendNotification({
                    message: 'Failed to launch game',
                    id: Math.random().toString(36).substring(7),
                    type: 'error'
                });
                console.error('Failed to launch game');
                mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
            });
            spawnedItem.on('exit', (exit) => {
                console.log('Game exited with code: ' + exit);
                if (exit !== 0) {
                    sendNotification({
                        message: 'Game Crashed',
                        id: Math.random().toString(36).substring(7),
                        type: 'error'
                    });

                    mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
                    return
                }
                
                mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
            });

            mainWindow?.webContents.send('game:launch', { id: appInfo.appID });
        });

        ipcMain.handle('app:remove-app', async (_, appid: number) => {
            if (!fs.existsSync('./library')) {
                return;
            }
            if (!fs.existsSync('./internals')) {
                fs.mkdirSync('./internals');
            }
            if (!fs.existsSync('./library/' + appid + '.json')) {
                return;
            }
            fs.unlinkSync('./library/' + appid + '.json');
            const appsInternal = JSON.parse(fs.readFileSync('./internals/apps.json', 'utf-8'));
            const index = appsInternal.indexOf(appid);
            if (index > -1) {
                appsInternal.splice(index, 1);
            }
            fs.writeFileSync('./internals/apps.json', JSON.stringify(appsInternal, null, 2));
            return;
        });

        
        ipcMain.handle('app:insert-app', async (_, data: LibraryInfo) => {
            if (!fs.existsSync('./library')) 
                fs.mkdirSync('./library');

            const appPath = `./library/${data.appID}.json`;
            fs.writeFileSync(appPath, JSON.stringify(data, null, 2));
            if (!fs.existsSync('./internals')) {
                fs.mkdirSync('./internals');
            }
            // write to the internal file
            if (!fs.existsSync('./internals/apps.json')) {
                fs.writeFileSync('./internals/apps.json', JSON.stringify([], null, 2));
            }
            const appsInternal = JSON.parse(fs.readFileSync('./internals/apps.json', 'utf-8'));
            appsInternal.push(data.appID);
            fs.writeFileSync('./internals/apps.json', JSON.stringify(appsInternal, null, 2));

            if (process.platform === 'linux') {
                // use steamtinkerlaunch to add the game to steam
                exec(`./bin/steamtinkerlaunch/steamtinkerlaunch addnonsteamgame --app-name="${data.name}" --exepath="${data.launchExecutable}" --startdir="${data.cwd}" --launchoptions=${data.launchArguments ?? ''} --compatibilitytool="default"`, {
                    cwd: __dirname
                }, (error, stdout, stderr) => {
                    if (error) {
                        console.error(error);
                        sendNotification({
                            message: 'Failed to add game to Steam',
                            id: Math.random().toString(36).substring(7),
                            type: 'error'
                        });
                        return;
                    }
                    console.log(stdout);
                    console.log(stderr);
                    sendNotification({
                        message: 'Game added to Steam',
                        id: Math.random().toString(36).substring(7),
                        type: 'success'
                    });
                });
            }
            return;
        });
        ipcMain.handle('app:get-all-apps', async () => {
            if (!fs.existsSync('./library')) {
                return [];
            }
            const files = fs.readdirSync('./library');
            const apps: LibraryInfo[] = [];
            for (const file of files) {
                const data = fs.readFileSync(`./library/${file}`, 'utf-8');
                apps.push(JSON.parse(data));
            }
            return apps;
        });

        ipcMain.on('fs:read', (event, arg) => {
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
            fs.access(arg, (err) => {
                if (err) {
                    event.returnValue = false;
                    return;
                }
                event.returnValue = true;
            });
        });
        ipcMain.on('fs:write', (event, arg) => {
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
            const files = fs.readdirSync(arg);
            return files;
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
            if (process.platform === 'win32') {
                let s7ZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';
                await new Promise<void>((resolve, reject) => exec(`${s7ZipPath} x "${rarFilePath}" -o"${outputDir}"`, (err, stdout, stderr) => {
                    if (err) {
                        console.error(err);
                        reject();
                        throw new Error('Failed to extract RAR file');
                    }
                    console.log(stdout);
                    console.log(stderr);
                    resolve();
                }));
            }

            if (process.platform === 'linux') {
                if (rarFilePath.endsWith('.rar')) {
                    await new Promise<void>((resolve) => exec(`unrar x "${rarFilePath}" "${outputDir}"`, (stdout, stderr) => {
                        console.log(stdout);
                        console.log(stderr);
                        resolve();
                    }));
                }
                else if (rarFilePath.endsWith('.zip')) {
                    await new Promise<void>((resolve) => exec(`unzip "${rarFilePath}" -d "${outputDir}"`, (stdout, stderr) => {
                        console.log(stdout);
                        console.log(stderr);
                        resolve();
                    }));
                }
            }
                
            return outputDir;
        });

        ipcMain.handle('real-debrid:set-key', async (_, arg) => {
            realDebridClient = new RealDebrid({
                apiKey: arg
            });
            return 'success';
        });

        ipcMain.handle('real-debrid:update-key', async () => {
            if (!fs.existsSync('./config/option/realdebrid.json')) {
                return false;
            }
            const rdInfo = fs.readFileSync('./config/option/realdebrid.json', 'utf-8');
            const rdInfoJson = JSON.parse(rdInfo);
            realDebridClient = new RealDebrid({
                apiKey: rdInfoJson.debridApiKey
            });
            return true;
        });

        ipcMain.handle('real-debrid:add-magnet', async (_, arg) => {
            const torrentAdded = await realDebridClient.addMagnet(arg.url, arg.host);
            return torrentAdded;
        });

        // real-debrid binding
        ipcMain.handle('real-debrid:get-user-info', async () => {
            const userInfo = await realDebridClient.getUserInfo();
            return userInfo;
        });

        ipcMain.handle('real-debrid:unrestrict-link', async (_, arg) => {
            const unrestrictedLink = await realDebridClient.unrestrictLink(arg);
            return unrestrictedLink;
        });
            
        ipcMain.handle('real-debrid:get-hosts', async () => {
            const hosts = await realDebridClient.getHosts();
            return hosts;
        });

        ipcMain.handle('real-debrid:get-torrent-info', async (_, arg) => {
            const torrents = await realDebridClient.getTorrentInfo(arg);
            return torrents;
        });

        ipcMain.handle('real-debrid:is-torrent-ready', async (_, arg) => {
            const torrentReady = await realDebridClient.isTorrentReady(arg);
            return torrentReady;
        })

        ipcMain.handle('real-debrid:select-torrent', async (_, arg) => {
            const selected = await realDebridClient.selectTorrents(arg);
            return selected;
        })
        ipcMain.handle('real-debrid:add-torrent', async (_, arg) => {
            // arg.url is a link to the download, we need to get the file
            // and send it to the real-debrid API
            console.log(arg);
            try {

                const fileStream = fs.createWriteStream('./temp.torrent');
                const downloadID = Math.random().toString(36).substring(7);
                const torrentData = await new Promise<ReadStream>((resolve, reject) => {
                    axios({
                        method: 'get',
                        url: arg.torrent,
                        responseType: 'stream'
                    }).then(response => {
                        response.data.pipe(fileStream);

                        fileStream.on('finish', () => {
                            console.log('Download complete!!');
                            fileStream.close();
                            resolve(fs.createReadStream('./temp.torrent'));
                        });

                        fileStream.on('error', (err) => {
                            console.error(err);
                            fileStream.close();
                            fs.unlinkSync(arg.path);
                            reject();
                        });
                    });
                }).catch(err => {
                    if (!mainWindow || !mainWindow.webContents) {
                        console.error("Seems like the window is closed. Cannot send error message to renderer.")
                        return
                    }
                    console.error(err);
                    mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                    fileStream.close();
                    fs.unlinkSync(arg.path);
                    sendNotification({
                        message: 'Download failed for ' + arg.path,
                        id: downloadID,
                        type: 'error'
                    });
                });
                if (!torrentData) {
                    return null;
                }
                console.log("Downloaded torrent! Now adding to readDebrid")
                
                const data = await realDebridClient.addTorrent(torrentData as ReadStream);
                console.log("Added torrent to real-debrid!")
                return data
            } catch (except) {
                console.error(except);
                sendNotification({
                    message: "Failed to add torrent to Real-Debrid",
                    id: Math.random().toString(36).substring(7),
                    type: 'error'
                });
                return null;
            }

        });

        ipcMain.handle('torrent:download-torrent', async (_, arg: { link: string, path: string }) => {
            await refreshCached('general');
            const torrentClient: string = await getStoredValue('general', 'torrentClient') ?? 'webtorrent';

            switch (torrentClient) {
                case 'qbittorrent': {
                    try {
                        await refreshCached('qbittorrent');
                        qbitClient = new QBittorrent({
                            baseUrl: ((await getStoredValue('qbittorrent', 'qbitHost')) ?? 'http://127.0.0.1') + ":" + ((await getStoredValue('qbittorrent', 'qbitPort')) ?? '8080'),
                            username: (await getStoredValue('qbittorrent', 'qbitUsername')) ?? 'admin', 
                            password: (await getStoredValue('qbittorrent', 'qbitPassword')) ?? ''
                        })
                        if (fs.existsSync(arg.path + '.torrent')) {
                            sendNotification({
                                message: 'File at path already exists. Please delete the file and try again.',
                                id: Math.random().toString(36).substring(7),
                                type: 'error'
                            });
                            if (mainWindow && mainWindow.webContents)
                                mainWindow.webContents.send('ddl:download-error', { id: Math.random().toString(36).substring(7), error: 'File at path already exists. Please delete the file and try again.' });
                            return null;
                        }
                        const downloadID = Math.random().toString(36).substring(7);
                        const torrentData = await new Promise<Buffer>((resolve, reject) => {
                            axios({
                                method: 'get',
                                url: arg.link,
                                responseType: 'stream'
                            }).then(response => {
                                const fileStream = fs.createWriteStream('./temp.torrent');
                                response.data.pipe(fileStream);

                                fileStream.on('finish', async () => {
                                    console.log('Download complete!!');
                                    fileStream.close();
                                    resolve(await readFile('./temp.torrent'));
                                });

                                fileStream.on('error', (err) => {
                                    console.error(err);
                                    fileStream.close();
                                    fs.unlinkSync(arg.path);
                                    reject();
                                });
                            });
                        }).catch(err => {
                            if (!mainWindow || !mainWindow.webContents) {
                                console.error("Seems like the window is closed. Cannot send error message to renderer.")
                                return
                            }
                            console.error(err);
                            mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                            sendNotification({
                                message: 'Download failed for ' + arg.path,
                                id: downloadID,
                                type: 'error'
                            });
                        });

                        if (!torrentData) {
                            return null;
                        }
                        await qbitClient.addTorrent(torrentData, {
                            savepath: arg.path + '.torrent'
                        })

                        arg.path = arg.path + '.torrent';
                        console.log("[torrent] Checking for torrent at path: " + arg.path)
                        let alreadyNotified = false;
                        const torrentInterval = setInterval(async () => {
                            if (!qbitClient) {
                                clearInterval(torrentInterval);
                                return;
                            }
                            const torrent = (await qbitClient.getAllData()).torrents.find(torrent => torrent.savePath === arg.path);
                            if (!torrent) {
                                clearInterval(torrentInterval);
                                console.error('Torrent not found in qBitTorrent...');
                                return;
                            }

                            const progress = torrent.progress;
                            const downloadSpeed = torrent.downloadSpeed;
                            const fileSize = torrent.totalSize;
                            const ratio = torrent.totalUploaded / torrent.totalDownloaded;
                            if (!mainWindow || !mainWindow.webContents) {
                                console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                                return
                            }
                            mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed, progress, fileSize, ratio });
                            if (torrent.isCompleted && !alreadyNotified) {
                                mainWindow.webContents.send('torrent:download-complete', { id: downloadID });
                                alreadyNotified = true;
                                console.log('Torrent download finished');
                            }
                        }, 250);
                        torrentIntervals.push(torrentInterval);
                        return downloadID;
                    } catch (except) {
                        console.error(except);
                        sendNotification({
                            message: "Failed to download torrent. Check if qBitTorrent is running.",
                            id: Math.random().toString(36).substring(7),
                            type: 'error'
                        });
                        return null;
                    }
                    break;
                }
                case 'webtorrent': {
                    try {
                        const fileStream = fs.createWriteStream('./temp.torrent');
                        const downloadID = Math.random().toString(36).substring(7);
                        const torrentData = await new Promise<Uint8Array>((resolve, reject) => {
                            axios({
                                method: 'get',
                                url: arg.link,
                                responseType: 'stream'
                            }).then(response => {
                                response.data.pipe(fileStream);

                                fileStream.on('finish', () => {
                                    console.log('Download complete!!');
                                    fileStream.close();
                                    resolve(fs.readFileSync('./temp.torrent'));
                                });

                                fileStream.on('error', (err) => {
                                    console.error(err);
                                    fileStream.close();
                                    fs.unlinkSync(arg.path);
                                    reject();
                                });
                            });
                        }).catch(err => {
                            if (!mainWindow || !mainWindow.webContents) {
                                console.error("Seems like the window is closed. Cannot send error message to renderer.")
                                return
                            }
                            console.error(err);
                            mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                            fileStream.close();
                            fs.unlinkSync(arg.path);
                            sendNotification({
                                message: 'Download failed for ' + arg.path,
                                id: downloadID,
                                type: 'error'
                            });
                        });
                        if (!torrentData) {
                            return null;
                        }

                        if (fs.existsSync(arg.path + '.torrent')) {
                            sendNotification({
                                message: 'File at path already exists. Please delete the file and try again.',
                                id: downloadID,
                                type: 'error'
                            });
                            if (mainWindow && mainWindow.webContents)
                                mainWindow.webContents.send('ddl:download-error', { id: Math.random().toString(36).substring(7), error: 'File at path already exists. Please delete the file and try again.' });
                            return null;
                        }

                        addTorrent(torrentData, arg.path + '.torrent', 
                            (_, speed, progress, length, ratio) => {
                                if (!mainWindow || !mainWindow.webContents) {
                                    console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                                    return
                                }
                                mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed: speed, progress, fileSize: length, ratio });
                            },
                            () => {
                                if (!mainWindow || !mainWindow.webContents) {
                                    console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                                    return
                                }
                                mainWindow.webContents.send('torrent:download-complete', { id: downloadID });
                                console.log('Torrent download finished');
                            }
                        );

                        return downloadID;

                        
                    } catch (except) {
                        console.error(except);
                        sendNotification({
                            message: "Failed to download torrent.",
                            id: Math.random().toString(36).substring(7),
                            type: 'error'
                        });
                        return null;
                    }
                    break;
                }
            }      
            return null;          
        });

        ipcMain.handle('torrent:download-magnet', async (_, arg: { link: string, path: string }) => {
            await refreshCached('general');
            const torrentClient: string = await getStoredValue('general', 'torrentClient') ?? 'webtorrent';

            switch (torrentClient) {
                case 'qbittorrent': {
                    try {
                        await refreshCached('qbittorrent');
                        qbitClient = new QBittorrent({
                            baseUrl: ((await getStoredValue('qbittorrent', 'qbitHost')) ?? 'http://127.0.0.1') + ":" + ((await getStoredValue('qbittorrent', 'qbitPort')) ?? '8080'),
                            username: (await getStoredValue('qbittorrent', 'qbitUsername')) ?? 'admin', 
                            password: (await getStoredValue('qbittorrent', 'qbitPassword')) ?? ''
                        })

                        if (fs.existsSync(arg.path + '.torrent')) {
                            sendNotification({
                                message: 'File at path already exists. Please delete the file and try again.',
                                id: Math.random().toString(36).substring(7),
                                type: 'error'
                            });
                            return null;
                        }

                        const downloadID = Math.random().toString(36).substring(7);
                        await qbitClient.addMagnet(arg.link, {
                            savepath: arg.path + '.torrent'
                        })
                        let alreadyNotified = false;
                        arg.path = arg.path + '.torrent';
                        console.log("[magnet] Checking for torrent at path: " + arg.path)
                        const torrentInterval = setInterval(async () => {
                            if (!qbitClient) {
                                clearInterval(torrentInterval);
                                return;
                            }
                            
                            const torrent = (await qbitClient.getAllData()).torrents.find(torrent => torrent.savePath === arg.path);
                            if (!torrent) {
                                clearInterval(torrentInterval);
                                console.error('Torrent not found in qBitTorrent...');
                                return;
                            }

                            const progress = torrent.progress;
                            const downloadSpeed = torrent.downloadSpeed;
                            const fileSize = torrent.totalSize;
                            const ratio = torrent.totalUploaded / torrent.totalDownloaded;
                            if (!mainWindow || !mainWindow.webContents) {
                                console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                                return
                            }
                            mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed, progress, fileSize, ratio });
                            if (torrent.isCompleted && !alreadyNotified) {
                                mainWindow.webContents.send('torrent:download-complete', { id: downloadID });
                                alreadyNotified = true;
                                console.log('Torrent download finished');
                            }
                        }, 250);
                        torrentIntervals.push(torrentInterval);
                        return downloadID;
                    } catch (except) {
                        console.error(except);
                        sendNotification({
                            message: "Failed to download torrent. Check if qBitTorrent is running.",
                            id: Math.random().toString(36).substring(7),
                            type: 'error'
                        });
                        return null;
                    }
                    break;
                }
                case 'webtorrent': {
                    try {
                        const downloadID = Math.random().toString(36).substring(7);

                        if (fs.existsSync(arg.path + '.torrent')) {
                            sendNotification({
                                message: 'File at path already exists. Please delete the file and try again.',
                                id: downloadID,
                                type: 'error'
                            });
                            if (mainWindow && mainWindow.webContents)
                                mainWindow.webContents.send('ddl:download-error', { id: Math.random().toString(36).substring(7), error: 'File at path already exists. Please delete the file and try again.' });
                            return null;
                        }

                        addTorrent(arg.link, arg.path + '.torrent', 
                            (_, speed, progress, length, ratio) => {
                                if (!mainWindow || !mainWindow.webContents) {
                                    console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                                    return
                                }
                                mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed: speed, progress, fileSize: length, ratio });
                            },
                            () => {
                                if (!mainWindow || !mainWindow.webContents) {
                                    console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                                    return
                                }
                                mainWindow.webContents.send('torrent:download-complete', { id: downloadID });
                                console.log('Torrent download finished');
                            }
                        );

                        return downloadID;

                        
                    } catch (except) {
                        console.error(except);
                        sendNotification({
                            message: "Failed to download torrent.",
                            id: Math.random().toString(36).substring(7),
                            type: 'error'
                        });
                        return null;
                    }
                    break;
                }
            }      
            return null;          
        });
        ipcMain.handle('ddl:download', async (_, args: { link: string, path: string }[]) => {
            const downloadID = Math.random().toString(36).substring(7);
            // arg is a link
            // download the link
            // get the name of the file
            new Promise<void>(async (resolve, reject) => {
                let parts = 0
                for (const arg of args) {
                    parts++
                    if (fs.existsSync(arg.path)) {
                        sendNotification({
                            message: 'File at path already exists. Please delete the file and try again.',
                            id: downloadID,
                            type: 'error'
                        });
                        if (mainWindow && mainWindow.webContents)
                            mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: 'File at path already exists. Please delete the file and try again.' });
                        return reject();
                    }
                    let fileStream = fs.createWriteStream(arg.path);

                    // get file size first
                    console.log("Starting download...")

                    fileStream.on('error', (err) => {
                        console.error(err);
                        if (mainWindow && mainWindow.webContents)
                            mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                        fileStream.close();
                        reject()
                    });
                    await new Promise<void>((resolve_dw, reject_dw) => 
                        axios({
                            method: 'get',
                            url: arg.link,
                            responseType: 'stream'
                        }).then(response => {
                            let fileSize = response.headers['content-length']!!;
                            const startTime = Date.now();
                            response.data.pipe(fileStream);
                            response.data.on('data', () => {
                                const progress = fileStream.bytesWritten / fileSize;
                                const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
                                const downloadSpeed = response.data.socket.bytesRead / elapsedTime;
                                if (mainWindow && mainWindow.webContents)
                                    mainWindow.webContents.send('ddl:download-progress', { id: downloadID, progress, downloadSpeed, fileSize, part: parts, totalParts: args.length });
                                else
                                    response.data.destroy()
                            });

                            response.data.on('end', () => {
                                console.log("Download complete for part " + parts)
                                fileStream.close();
                                resolve_dw();
                            });

                            response.data.on('error', () => {
                                if (mainWindow && mainWindow.webContents)
                                    mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: '' });
                                fileStream.close();
                                fs.unlinkSync(arg.path);
                                reject_dw();
                            });
                        }).catch(err => {
                            console.error(err);
                            if (mainWindow && mainWindow.webContents)
                                mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                            fileStream.close();
                            fs.unlinkSync(arg.path);
                            sendNotification({
                                message: 'Download failed for ' + arg.path,
                                id: downloadID,
                                type: 'error'
                            });
                            reject_dw();
                        })
                    );
                }
                if (mainWindow && mainWindow.webContents)
                    mainWindow.webContents.send('ddl:download-complete', { id: downloadID });
                resolve();
                
            }).then(() => {
                console.log('Download complete!!');
            }).catch((err) => {
                console.log('Download failed');
                sendNotification({
                    message: 'Direct Download Failed',
                    id: downloadID,
                    type: 'error'
                });
                console.error(err);
            });
            // stream the download 
            return downloadID;
        });

        ipcMain.handle('install-addons', async (_, addons) => {
            // addons is an array of URLs to the addons to install. these should be valid git repositories
            // check if git is installed
            if (!fs.existsSync('./addons/')) {
                fs.mkdirSync('./addons/');
            }

            // check if git is installed
            const gitInstalled = await new Promise<boolean>((resolve, _) => {
                exec('git --version', (err, stdout, _) => {
                    if (err) {
                        resolve(false);
                    }
                    console.log(stdout);
                    resolve(true);
                });
            });
            if (!gitInstalled) {
                sendNotification({
                    message: 'Git is not installed. Please install git and try again.',
                    id: Math.random().toString(36).substring(7),
                    type: 'error'
                });
                return;
            }

            for (const addon of addons) {
                const addonName = addon.split(/\/|\\/).pop()!!;
                const isLocal = addon.startsWith('local:');
                let addonPath = `./addons/${addonName}`;
                if (addon.startsWith('local:')) {
                    addonPath = addon.split('local:')[1];
                }
                if (fs.existsSync(join(addonPath, 'installation.log'))) {
                    console.log(`Addon ${addonName} already installed and setup.`);
                    sendNotification({
                        message: `Addon ${addonName} already installed and setup.`,
                        id: Math.random().toString(36).substring(7),
                        type: 'info'
                    });
                    continue;
                }

                if (!isLocal) {
                    await new Promise<void>((resolve, reject) => {
                        exec(`git clone ${addon} ${addonPath}`, (err, stdout, _) => {
                            if (err) {
                                sendNotification({
                                    message: `Failed to install addon ${addonName}`,
                                    id: Math.random().toString(36).substring(7),
                                    type: 'error'
                                });
                                console.error(err);
                                return reject();
                            }
                            console.log(stdout);
                            resolve();
                        });
                   });
                }

                const hasAddonBeenSetup = await setupAddon(addonPath);
                if (!hasAddonBeenSetup) {
                    sendNotification({
                        message: `An error occurred when setting up ${addonName}`,
                        id: Math.random().toString(36).substring(7),
                        type: 'error'
                    });
                }
                else {
                    sendNotification({
                        message: `Addon ${addonName} installed successfully.`,
                        id: Math.random().toString(36).substring(7),
                        type: 'success'
                    });
                }
            }

            return;
        });

        ipcMain.handle('restart-addon-server', async (_) => {
            restartAddonServer(); 
        });

        ipcMain.handle('clean-addons', async (_) => {
            // stop all of the addons
            for (const process of Object.keys(processes)) {
                console.log(`Killing process ${process}`);
                processes[process].kill('SIGKILL');
            }

            // delete all of the addons
            fs.rmdirSync('./addons/', { recursive: true });
            fs.mkdirSync('./addons/');

            sendNotification({
                message: 'Successfully cleaned addons.',
                id: Math.random().toString(36).substring(7),
                type: 'info'
            });
        });

        const sevenZipDownload = "https://7-zip.org/a/7z2407-x64.exe"

        ipcMain.handle('oobe:download-tools', async (_) => {
            // check if 7zip is installed
            let cleanlyDownloadedAll = true;
            let sevenZipPath = '';
            if (process.platform === 'win32') {
                sevenZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';
                const sevenZipInstalled = await new Promise<boolean>((resolve, _) => {
                    exec(sevenZipPath + ' --help', (err, stdout, _) => {
                        if (err) {
                            resolve(false);
                        }
                        console.log(stdout);
                        resolve(true);
                    });
                });
                if (!sevenZipInstalled) {
                    await new Promise<void>((resolve, reject) => axios({
                        method: 'get',
                        url: sevenZipDownload,
                        responseType: 'stream'
                    }).then(response => {
                        const fileStream = fs.createWriteStream('./7z-install.exe');
                        response.data.pipe(fileStream);
                        fileStream.on('finish', async () => {
                            console.log('Downloaded 7zip');
                            fileStream.close();
                            exec('7z-install.exe /S /D="C:\\Program Files\\7-Zip"', (err, stdout, stderr) => {
                                if (err) {
                                    console.error(err);
                                    sendNotification({
                                        message: 'Failed to install 7zip. Please allow the installer to run as administrator.',
                                        id: Math.random().toString(36).substring(7),
                                        type: 'error'
                                    });
                                    cleanlyDownloadedAll = false;
                                    reject();
                                    return;
                                }
                                console.log(stdout);
                                console.log(stderr);
                                fs.unlinkSync('./7z-install.exe');
                                sendNotification({
                                    message: 'Successfully installed 7zip.',
                                    id: Math.random().toString(36).substring(7),
                                    type: 'info'
                                });
                                resolve();
                            })
                        });

                        fileStream.on('error', (err) => {
                            console.error(err);
                            fileStream.close();
                            fs.unlinkSync('./7z-install.exe');
                            cleanlyDownloadedAll = false;
                        });
                    }).catch(err => {
                        console.error(err);
                    }));
                    
                }

            }

            // check if git is installed
            const gitInstalled = await new Promise<boolean>((resolve, _) => {
                exec('git --version', (err, stdout, _) => {
                    if (err) {
                        resolve(false);
                    }
                    console.log(stdout);
                    resolve(true);
                });
            });
            if (!gitInstalled) {
                if (process.platform === 'win32') {

                    const gitDownload = "https://github.com/git-for-windows/git/releases/download/v2.46.0.windows.1/Git-2.46.0-64-bit.exe"
                    await new Promise<void>((resolve, reject) => axios({
                        method: 'get',
                        url: gitDownload,
                        responseType: 'stream'
                    }).then(response => {
                        const fileStream = fs.createWriteStream('./git-install.exe');
                        response.data.pipe(fileStream);
                        fileStream.on('finish', async () => {
                            console.log('Downloaded git');
                            fileStream.close();

                            fs.writeFileSync('git_install.ini', `
    [Setup]
    Lang=default
    Dir=C:\Program Files\Git
    Group=Git
    NoIcons=0
    SetupType=default
    Components=gitlfs,assoc,assoc_sh,windowsterminal
    Tasks=
    EditorOption=VIM
    CustomEditorPath=
    DefaultBranchOption=main
    PathOption=Cmd
    SSHOption=OpenSSH
    TortoiseOption=false
    CURLOption=WinSSL
    CRLFOption=CRLFCommitAsIs
    BashTerminalOption=MinTTY
    GitPullBehaviorOption=Merge
    UseCredentialManager=Enabled
    PerformanceTweaksFSCache=Enabled
    EnableSymlinks=Disabled
    EnablePseudoConsoleSupport=Disabled
    EnableFSMonitor=Disabled
                            `)
                            exec('git-install.exe /VERYSILENT /NORESTART /NOCANCEL /LOADINF=git_options.ini', (err, stdout, stderr) => {
                                if (err) {
                                    console.error(err);
                                    reject();
                                    cleanlyDownloadedAll = false;
                                    return;
                                }
                                console.log(stdout);
                                console.log(stderr);
                                fs.unlinkSync('./git-install.exe');
                                sendNotification({
                                    message: 'Successfully installed git.',
                                    id: Math.random().toString(36).substring(7),
                                    type: 'info'
                                });
                                resolve();
                            })
                        });

                        fileStream.on('error', (err) => {
                            console.error(err);
                            fileStream.close();
                            fs.unlinkSync('./git-install.exe');
                        });
                    }).catch(err => {
                        console.error(err);
                    }));
                }
                else {
                    sendNotification({
                        id: Math.random().toString(36).substring(7),
                        message: "Missing Git and auto-install is not supported for linux.",
                        type: "error"
                    });
                }
            }

            // check if steamtinkerlaunch is installed
            if (process.platform === 'linux') {
                if (!fs.existsSync('./bin/steamtinkerlaunch/steamtinkerlaunch')) {
                    await new Promise<void>((resolve, reject) => {
                    exec('git clone https://github.com/sonic2kk/steamtinkerlaunch ' + './bin/steamtinkerlaunch', (err, stdout, stderr) => {
                            if (err) {
                                console.error(err);
                                reject();
                                cleanlyDownloadedAll = false;
                                return;
                            }
                            console.log(stdout);
                            console.log(stderr);
                            // run chmod +x on the file
                            exec('chmod +x ./bin/steamtinkerlaunch/steamtinkerlaunch', (err) => {
                                if (err) {
                                    console.error(err);
                                    reject();
                                    cleanlyDownloadedAll = false;
                                    return;
                                }

                                // now executing steamtinkerlaunch
                                exec('./bin/steamtinkerlaunch/steamtinkerlaunch', (err, stdout, stderr) => {
                                    if (err) {
                                        console.error(err);
                                        reject();
                                        cleanlyDownloadedAll = false;
                                        return;
                                    }
                                    console.log(stdout);
                                    console.log(stderr);
                                    sendNotification({
                                        message: 'Successfully installed steamtinkerlaunch.',
                                        id: Math.random().toString(36).substring(7),
                                        type: 'info'
                                    });
                                    resolve();
                                });
                            }); 
                        });
                    });
                }
                else {
                    await new Promise<void>((resolve, reject) => {
                        exec('git pull', { cwd: './bin/steamtinkerlaunch' }, (err, stdout, stderr) => {
                            if (err) {
                                console.error(err);
                                reject();
                                cleanlyDownloadedAll = false;
                                return;
                            }
                            console.log(stdout);
                            console.log(stderr);
                            // run chmod +x on the file
                            exec('chmod +x ./bin/steamtinkerlaunch/steamtinkerlaunch', (err, stdout, stderr) => {
                                if (err) {
                                    console.error(err);
                                    reject();
                                    cleanlyDownloadedAll = false;
                                    return;
                                }
                                console.log(stdout);
                                console.log(stderr);
                                sendNotification({
                                    message: 'Successfully updated steamtinkerlaunch.',
                                    id: Math.random().toString(36).substring(7),
                                    type: 'info'
                                });
                                resolve();
                            }); 
                        });
                    });
                }
            }

            // check if bun is installed
            const bunInstalled = await new Promise<boolean>((resolve, _) => {
                exec('bun --version', (err, stdout, _) => {
                    if (err) {
                        resolve(false);
                    }
                    console.log(stdout);
                    resolve(true);
                });
            });

            if (!bunInstalled) {
                if (process.platform === 'win32') {
                    await new Promise<void>((resolve, reject) => exec('powershell -c "irm bun.sh/install.ps1 | iex"', (err, stdout, stderr) => {
                        if (err) {
                            console.error(err);
                            reject();
                            cleanlyDownloadedAll = false;
                            return;
                        }
                        console.log(stdout);
                        console.log(stderr);
                        sendNotification({
                            message: 'Successfully installed bun.',
                            id: Math.random().toString(36).substring(7),
                            type: 'info'
                        });
                        resolve();
                    }))
                }
                else if (process.platform === 'linux') {
                        await new Promise<void>((resolve, reject) => {
                            exec('curl -fsSL https://bun.sh/install | bash', (err, stdout, stderr) => {
                                // then export to path
                                if (err) {
                                    console.error(err);
                                    reject();
                                    cleanlyDownloadedAll = false;
                                    return;
                                }
                                console.log(stdout);
                                console.log(stderr);
                                // get linux name 
                                const linuxName = os.userInfo().username;

                                exec('echo "export PATH=$PATH:/home/' + linuxName + '/.bun/bin" >> ~/.bashrc', (err, stdout, stderr) => {
                                    if (err) {
                                        console.error(err);
                                        reject();
                                        cleanlyDownloadedAll = false;
                                        return;
                                    }
                                    console.log(stdout);
                                    console.log(stderr);
                                    sendNotification({
                                        message: 'Successfully installed bun and added to path.',
                                        id: Math.random().toString(36).substring(7),
                                        type: 'info'
                                    });
                                    resolve();

                                });

                            })
                        })
                }
                
            }
            else {
                await new Promise<void>((resolve, reject) => exec('bun upgrade', (err, stdout, stderr) => {
                    if (err) {
                        console.error(err);
                        reject();
                        return;
                    }
                    console.log(stdout);
                    console.log(stderr);
                    sendNotification({
                        message: 'Successfully upgraded bun.',
                        id: Math.random().toString(36).substring(7),
                        type: 'info'
                    });
                    resolve();
                }))
            }

            return cleanlyDownloadedAll;
        });

        ipcMain.on('get-version', async (event) => {
            event.returnValue = VERSION;
        });

        ipcMain.handle('update-addons', async (_) => {
            // stop all of the addons
            for (const process of Object.keys(processes)) {
                console.log(`Killing process ${process}`);
                processes[process].kill('SIGKILL');
            }

            // pull all of the addons
            if (!fs.existsSync('./addons/')) {
                return;
            }
            const addons = fs.readdirSync('./addons/');

            let addonsUpdated = 0;
            let failed = false;
            for (const addon of addons) {
                const addonPath = './addons/' + addon;
                if (!fs.existsSync(addonPath + '/.git')) {
                    console.log(`Addon ${addon} is not a git repository`);
                    continue;
                }
                // get rid of the installation log
                if (fs.existsSync(addonPath + '/installation.log')) {
                    fs.unlinkSync(addonPath + '/installation.log');
                }

                new Promise<void>((resolve, reject) => {
                    exec(`git fetch`, { cwd: addonPath },  (err, stdout, _) => {
                        if (err) {
                            sendNotification({
                                message: `Failed to update addon ${addon}`,
                                id: Math.random().toString(36).substring(7),
                                type: 'error'
                            });
                            console.error(err);
                            failed = true;
                            reject();
                            return;
                        }
                        console.log(stdout);
                        sendNotification({
                            message: `Addon ${addon} updated successfully.`,
                            id: Math.random().toString(36).substring(7),
                            type: 'info'
                        });
                        // setup the addon
                        setupAddon(addonPath).then((success) => {
                            if (!success) {
                                sendNotification({
                                    message: `An error occurred when setting up ${addon}`,
                                    id: Math.random().toString(36).substring(7),
                                    type: 'error'
                                });
                                failed = true;
                                reject();
                                return;
                            }
                            addonsUpdated++;
                            console.log(`Addon ${addon} updated successfully.`);
                            resolve();
                        });
                    });
                });
            }

            await new Promise<void>((resolve, reject) => {
                const interval = setInterval(() => {
                    if (addonsUpdated === addons.length) {
                        resolve();
                        clearInterval(interval);
                    }
                    if (failed) {
                        reject();
                        clearInterval(interval);
                    }
                }, 50)
            });

            // restart all of the addons
            restartAddonServer();

            sendNotification({
                message: 'Successfully updated addons.',
                id: Math.random().toString(36).substring(7),
                type: 'info'
            });
        });

            
        mainWindow!!.show()
        // start the app with it being focused
        mainWindow!!.focus()

        checkForAddonUpdates()
        if (!isSecurityCheckEnabled) {
            sendNotification({
                message: 'Security checks are disabled and application security LOWERED. Only enable if you know what you\'re doing.',
                id: Math.random().toString(36).substring(7),
                type: 'warning'
            });
        }

        mainWindow!!.webContents.setWindowOpenHandler((details) => {
            shell.openExternal(details.url)
            return { action: 'deny' }
        })

        convertLibrary();

        app.on('browser-window-focus', function () {
            globalShortcut.register("CommandOrControl+R", () => {
                console.log("CommandOrControl+R is pressed: Shortcut Disabled");
            });
            globalShortcut.register("F5", () => {
                console.log("F5 is pressed: Shortcut Disabled");
            });
        });

        app.on('browser-window-blur', function () {
            globalShortcut.unregister("CommandOrControl+R");
            globalShortcut.unregister("F5");
        });

        // disable devtools
        mainWindow!!.webContents.on('devtools-opened', () => {
            if (!isDev())
                mainWindow!!.webContents.closeDevTools()
        })


        app.on('web-contents-created', (_, contents) => {

            contents.on('will-navigate', (event, navigationUrl) => {
                const parsedUrl = new URL(navigationUrl)

                if (parsedUrl.origin !== 'http://localhost:8080' && parsedUrl.origin !== 'file://') {
                    event.preventDefault()
                    throw new Error('Navigating to that address is not allowed.')
                }
            })
        });

    });
}

async function convertLibrary() {
    // read the library directory
    const libraryPath = './library/';
    if (!fs.existsSync(libraryPath)) {
        return;
    }
    const files = fs.readdirSync(libraryPath);
    for (const file of files) {
        const filePath = join(libraryPath, file);
        const fileData = fs.readFileSync(filePath, 'utf-8');
        let data: LibraryInfo & { steamAppID?: number } = JSON.parse(fileData);
        if (data.steamAppID) {
            // convert the app id to an appID
            data.appID = data.steamAppID;
            delete data.steamAppID;
            data.coverImage = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${data.appID}/library_hero.jpg`;
            data.titleImage = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${data.appID}/logo_2x.png`;
            data.addonsource = 'steam';
            data.storefront = 'steam';
            fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
            console.log(`Converted ${file} to new format`);
        }
    }

}
async function checkForGitUpdates(repoPath: string): Promise<boolean> {
    // Change the directory to the repository path and run 'git fetch --dry-run'
    return new Promise((resolve, _) => {
        exec('git fetch --dry-run', { cwd: repoPath }, (error, stdout, stderr) => {
            if (error) {
                sendNotification({
                    message: 'Failed to check for updates',
                    id: Math.random().toString(36).substring(7),
                    type: 'error'
                });
                console.log(error);
                resolve(false);
                return
            }

            // If stdout is not empty, it means there are updates
            // auto remove the warning:
            const output = stdout + stderr;
            const cleanedOutput = output.replace(/warning: redirecting to .*/, '');
            console.log(cleanedOutput);

            if (cleanedOutput.trim()) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

function checkForAddonUpdates() {
    if (!fs.existsSync('./addons/')) {
        return;
    }
    const addons = fs.readdirSync('./addons/');
    for (const addon of addons) {
        const addonPath = './addons/' + addon;
        if (!fs.existsSync(addonPath + '/.git')) {
            console.log(`Addon ${addon} is not a git repository`);
            continue;
        }

        new Promise<void>(async (resolve, _) => {
            const isUpdate = await checkForGitUpdates(addonPath)
            if (isUpdate) {
                sendNotification({
                    message: `Addon ${addon} has updates.`,
                    id: Math.random().toString(36).substring(7),
                    type: 'info'
                });
                mainWindow!!.webContents.send('addon:update-available', addon);
                console.log(`Addon ${addon} has updates.`);
                resolve();
            }
            console.log(`Addon ${addon} is up to date.`);
            resolve();
        });
    }
}
// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
    createWindow();
    server.listen(port, () => {
        console.log(`Addon Server is running on http://localhost:${port}`);
        console.log(`Server is being executed by electron!`)
    }); 
    startAddons();

});

function startAddons() {
    // start all of the addons
    if (!fs.existsSync('./config/option/general.json')) {
        return
    }

    const generalConfig = JSON.parse(fs.readFileSync('./config/option/general.json', 'utf-8'));
    const addons = generalConfig.addons;
    for (const addon of addons) {
        let addonPath = '';
        if (addon.startsWith('local:')) {
            addonPath = addon.split('local:')[1];
        }
        else {
            addonPath = join(__dirname, 'addons', addon.split(/\/|\\/).pop());
        }

        if (!fs.existsSync(addonPath)) {
            console.error(`Addon ${addonPath} does not exist`);
            sendNotification({
                message: `Addon ${addonPath} does not exist`,
                id: Math.random().toString(36).substring(7),
                type: 'error'
            });
            continue;
        }

        if (!fs.existsSync(join(addonPath, 'installation.log'))) {
            console.log(`Addon ${addonPath} has not been installed yet.`);
            continue;
        }

        console.log(`Starting addon ${addonPath}`);
        startAddon(addonPath);
    }
}

function restartAddonServer() {
    // stop the server
    console.log('Stopping server...');
    server.close();
    clients.clear();
    // stop all of the addons
    for (const process of Object.keys(processes)) {
        console.log(`Killing process ${process}`);
        const killed = processes[process].kill('SIGKILL');
        console.log(`Killed process ${process}: ${killed}`);
    }
    // start the server
    server.listen(port, () => {
        console.log(`Addon Server is running on http://localhost:${port}`);
        console.log(`Server is being executed by electron!`)
    });
    startAddons();

    sendNotification({
        message: 'Addon server restarted successfully.',
        id: Math.random().toString(36).substring(7),
        type: 'success'
    });
}

// Quit when all windows are closed.
app.on('window-all-closed', async function () {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') app.quit()
    // stop torrenting
    console.log('Stopping torrent client...');
    await stopClient();
    // stop the server
    console.log('Stopping server...');
    server.close();
    // stop all of the addons
    for (const process of Object.keys(processes)) {
        console.log(`Killing process ${process}`);
        processes[process].kill('SIGKILL');
    }
    // stopping all of the torrent intervals
    for (const interval of torrentIntervals) {
        clearInterval(interval);
    }
});

app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) createWindow()
});
// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.