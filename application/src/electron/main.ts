import { join } from 'path';
import { server, port, clients } from "./server/addon-server"
import { applicationAddonSecret } from './server/constants';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs, { ReadStream } from 'fs';
import RealDebrid from 'node-real-debrid';
import https from 'https';
import { exec } from 'child_process';
import { processes, setupAddon, startAddon } from './addon-init-configure';
import { isSecurityCheckEnabled } from './server/AddonConnection';

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
            preload: join(__dirname, 'preload.js')
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

        ipcMain.on('real-debrid:set-key', async (event, arg) => {
            realDebridClient = new RealDebrid({
                apiKey: arg
            });
            event.returnValue = 'success';
        });

        ipcMain.on('real-debrid:update-key', async (event) => {
            if (!fs.existsSync('./config/option/realdebrid.json')) {
                return event.returnValue = false;
            }
            const rdInfo = fs.readFileSync('./config/option/realdebrid.json', 'utf-8');
            const rdInfoJson = JSON.parse(rdInfo);
            realDebridClient = new RealDebrid({
                apiKey: rdInfoJson.debridApiKey
            });
            return event.returnValue = true;
        });

        ipcMain.on('real-debrid:add-magnet', async (event, arg) => {
            const torrentAdded = await realDebridClient.addMagnet(arg.url, arg.host);
            event.returnValue = torrentAdded;
        });

        // real-debrid binding
        ipcMain.on('real-debrid:get-user-info', async (event, _) => {
            const userInfo = await realDebridClient.getUserInfo();
            event.returnValue = userInfo;
        });

        ipcMain.on('real-debrid:unrestrict-link', async (event, arg) => {
            const unrestrictedLink = await realDebridClient.unrestrictLink(arg);
            event.returnValue = unrestrictedLink;
        });
            
        ipcMain.on('real-debrid:get-hosts', async (event, _) => {
            const hosts = await realDebridClient.getHosts();
            event.returnValue = hosts;
        });
        ipcMain.on('real-debrid:add-magnet', async (event, arg) => {
            const torrentAdded = await realDebridClient.addMagnet(arg.url, arg.host);
            event.returnValue = torrentAdded;
        });

        ipcMain.on('real-debrid:get-torrent-info', async (event, arg) => {
            const torrents = await realDebridClient.getTorrentInfo(arg);
            event.returnValue = torrents;
        });

        ipcMain.on('real-debrid:is-torrent-ready', async (event, arg) => {
            const torrentReady = await realDebridClient.isTorrentReady(arg);
            event.returnValue = torrentReady;
        })

        ipcMain.on('real-debrid:select-torrent', async (event, arg) => {
            const selected = await realDebridClient.selectTorrents(arg);
            event.returnValue = selected;
        })
        ipcMain.on('real-debrid:get-torrents', async (event, _) => {
            const torrents = await realDebridClient.getTorrents();
            event.returnValue = torrents;
        });
        ipcMain.handle('real-debrid:add-torrent', async (_, arg) => {
            // arg.url is a link to the download, we need to get the file
            // and send it to the real-debrid API
            console.log(arg);
            try {
                const torrentData = await new Promise<ReadStream>((resolve, reject) => {
                    const url = new URL(arg.torrent);
                    const options = {
                        "method": "GET",
                        "hostname": url.hostname,
                        "port": null,
                        "path": url.pathname
                    };
                    https.get(options, (response) => {
                        response.pipe(fs.createWriteStream('./temp.torrent'));
                        response.on('end', async () => {
                            resolve(fs.createReadStream('./temp.torrent'));
                        });
                        response.on('error', (err) => {
                            reject(err);
                        });
                    });
                });
                console.log("Downloaded torrent! Now adding to readDebrid")
                const data = await realDebridClient.addTorrent(torrentData);
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

        })

        ipcMain.on('ddl:download', async (event, arg: { link: string, path: string }) => {
            const downloadID = Math.random().toString(36).substring(7);
            // arg is a link
            // download the link
            // get the name of the file
            new Promise<void>(async (resolve, reject) => {
                console.log(arg.link, arg.path);
                let fileStream = fs.createWriteStream(arg.path);

                // get file size first
                const url = new URL(arg.link);
                const fileSize = await new Promise<number>((resolve, reject) => https.get({
                    method: 'HEAD',
                    hostname: url.hostname,
                    path: url.pathname,
                }, (response) => {
                    if (response.statusCode !== 200) return reject(new Error('Invalid status code'));
                    resolve(parseFloat(response.headers['content-length']!!)!!);
                }));
                console.log("Starting download...")

                fileStream.on('error', (err) => {
                    console.error(err);
                    mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                    fileStream.close();
                    reject()
                });

                https.get(arg.link, (response) => {
                    console.log("Starting download...")
                    response.pipe(fileStream);

                    response.on('data', (chunk) => {
                        const downloadSpeed = chunk.length / 1024;
                        const progress = fileStream.bytesWritten / fileSize;
                        mainWindow.webContents.send('ddl:download-progress', { id: downloadID, progress, downloadSpeed, fileSize });
                    });

                    response.on('end', () => {
                        console.log("Download complete!")
                        fileStream.close();
                        mainWindow.webContents.send('ddl:download-complete', { id: downloadID });
                        resolve();
                    });

                    response.on('error', (err) => {
                        console.error(err);
                        mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                        fileStream.close();
                        fs.unlinkSync(arg.path);
                        reject();
                    });
                    // send the download status/progress as it goes to the client
                    // send how much is done and the download speed
                }).on('error', (err) => {
                    console.error(err);
                    mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                    fileStream.close();
                    fs.unlinkSync(arg.path);
                    sendNotification({
                        message: 'Download failed for ' + arg.path,
                        id: downloadID,
                        type: 'error'
                    });
                    reject();
                });
                
            }).then(() => {
                console.log('Download complete!!');
            }).catch((err) => {
                console.log('Download failed');
                sendNotification({
                    message: 'Download failed for ' + arg.link,
                    id: downloadID,
                    type: 'error'
                });
                console.error(err);
            });
            // stream the download 
            event.returnValue = downloadID;
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
app.on('window-all-closed', function () {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') app.quit()

    // stop the server
    console.log('Stopping server...');
    server.close();
    // stop all of the addons
    for (const process of Object.keys(processes)) {
        console.log(`Killing process ${process}`);
        processes[process].kill();
    }
});

app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) createWindow()
});
// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.