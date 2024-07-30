import { join } from 'path';
import { server, port, clients } from "./server/addon-server.js"
import { applicationAddonSecret } from './server/constants.js';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs, { ReadStream } from 'fs';
import { readFile } from 'fs/promises';
import RealDebrid from 'real-debrid-js';
import { exec } from 'child_process';
import { processes, setupAddon, startAddon } from './addon-init-configure.js';
import { isSecurityCheckEnabled } from './server/AddonConnection.js';
import axios from 'axios';
import { addTorrent, stopClient } from './webtorrent-connect.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { QBittorrent } from '@ctrl/qbittorrent';
import { getStoredValue, refreshCached } from './config-util.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let qbitClient: QBittorrent | undefined = undefined;
let torrentIntervals: NodeJS.Timeout[] = []
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow: any;
let realDebridClient = new RealDebrid({
    apiKey: 'UNSET'
}); 
function isDev() {
    return !app.isPackaged;
}

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

function createWindow() {    
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: true,
            preload: join(__dirname, 'preload.mjs')
        },
        title: 'OpenGameInstaller',
        fullscreenable: false,
        resizable: false,
        icon: join(__dirname, 'public/favicon.png'),
        show: false
    });

    // This block of code is intended for development purpose only.
    // Delete this entire block of code when you are ready to package the application.
    if (isDev()) {
        mainWindow.loadURL('http://localhost:8080/?secret=' + applicationAddonSecret);
    } else {
        mainWindow.loadURL("file://" + join(__dirname, '../public/index.html') + "?secret=" + applicationAddonSecret);
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
                    console.error(err);
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
            fs.mkdir(arg, (err) => {
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

            // use 7zip to extract the rar file
            let s7ZipPath = '"C:\\Program Files\\7-Zip\\7z.exe"';
            if (process.platform === 'linux' || process.platform === 'darwin') {
                s7ZipPath = '7z';
            }
            new Promise<void>((resolve, reject) => exec(`${s7ZipPath} x "${rarFilePath}" -o"${outputDir}"`, (err, stdout, stderr) => {
                if (err) {
                    console.error(err);
                    reject();
                    throw new Error('Failed to extract RAR file');
                }
                console.log(stdout);
                console.log(stderr);
                resolve();
            }));
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
                    if (!mainWindow.webContents) {
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
                        if (!qbitClient)
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
                            if (!mainWindow.webContents) {
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
                            if (!mainWindow.webContents) {
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
                            if (!mainWindow.webContents) {
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

                            mainWindow.webContents.send('ddl:download-error', { id: Math.random().toString(36).substring(7), error: 'File at path already exists. Please delete the file and try again.' });
                            return null;
                        }

                        addTorrent(torrentData, arg.path + '.torrent', 
                            (_, speed, progress, length, ratio) => {
                                if (!mainWindow.webContents) {
                                    console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                                    return
                                }
                                mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed: speed, progress, fileSize: length, ratio });
                            },
                            () => {
                                if (!mainWindow.webContents) {
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
            refreshCached('general');
            const torrentClient: string = await getStoredValue('general', 'torrentClient') ?? 'webtorrent';

            switch (torrentClient) {
                case 'qbittorrent': {
                    try {
                        refreshCached('qbittorrent');
                        if (!qbitClient)
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
                            if (!mainWindow.webContents) {
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
                            mainWindow.webContents.send('ddl:download-error', { id: Math.random().toString(36).substring(7), error: 'File at path already exists. Please delete the file and try again.' });
                            return null;
                        }

                        addTorrent(arg.link, arg.path + '.torrent', 
                            (_, speed, progress, length, ratio) => {
                                if (!mainWindow.webContents) {
                                    console.error("Seems like the window is closed. Cannot send progress message to renderer.")
                                    return
                                }
                                mainWindow.webContents.send('torrent:download-progress', { id: downloadID, downloadSpeed: speed, progress, fileSize: length, ratio });
                            },
                            () => {
                                if (!mainWindow.webContents) {
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
                        if (mainWindow.webContents)
                            mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: 'File at path already exists. Please delete the file and try again.' });
                        return reject();
                    }
                    let fileStream = fs.createWriteStream(arg.path);

                    // get file size first
                    console.log("Starting download...")

                    fileStream.on('error', (err) => {
                        console.error(err);
                        if (mainWindow.webContents)
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
                                if (mainWindow.webContents)
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
                                if (mainWindow.webContents)
                                    mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: '' });
                                fileStream.close();
                                fs.unlinkSync(arg.path);
                                reject_dw();
                            });
                        }).catch(err => {
                            console.error(err);
                            if (mainWindow.webContents)
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
            sendNotification({
                message: 'Frequently restarting the addon server can cause issues. Only restart if necessary.',
                id: Math.random().toString(36).substring(7),
                type: 'warning'
            });
            // stop the server
            console.log('Stopping server...');
            server.close();
            clients.clear();
            // stop all of the addons
            for (const process of Object.keys(processes)) {
                console.log(`Killing process ${process}`);
                processes[process].kill();
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
        });

        ipcMain.handle('clean-addons', async (_) => {
            // stop all of the addons
            for (const process of Object.keys(processes)) {
                console.log(`Killing process ${process}`);
                processes[process].kill();
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
        mainWindow!!.show()
        if (!isSecurityCheckEnabled) {
            sendNotification({
                message: 'Security checks are disabled and application security LOWERED. Only enable if you know what you\'re doing.',
                id: Math.random().toString(36).substring(7),
                type: 'warning'
            });
        }
    });
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
        processes[process].kill();
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