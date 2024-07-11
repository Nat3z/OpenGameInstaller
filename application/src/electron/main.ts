import { join } from 'path';
import { server, port } from "./server/addon-server"
import { applicationAddonSecret } from './server/constants';
import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import RealDebrid from 'node-real-debrid';
import https from 'https';

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow: any;
let realDebridClient = new RealDebrid({
    apiKey: 'UNSET'
}); 
function isDev() {
    return !app.isPackaged;
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
        icon: join(__dirname, 'public/favicon.png'),
        show: false
    });

    // This block of code is intended for development purpose only.
    // Delete this entire block of code when you are ready to package the application.
    if (isDev()) {
        mainWindow.loadURL('http://localhost:8080/?secret=' + applicationAddonSecret);
    } else {
        mainWindow.loadURL("file://" + join(__dirname, 'index.html') + "?secret=" + applicationAddonSecret);
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
                    host: url.host,
                    href: url.href,
                }, (response) => {
                    if (response.statusCode !== 200) return reject(new Error('Invalid status code'));
                    resolve(parseFloat(response.headers['content-length']!!)!!);
                }));
                console.log("Starting download...")
                https.get(arg.link, (response) => {
                    console.log("Starting download...")
                    response.pipe(fileStream);
                    // send the download status/progress as it goes to the client
                    // send how much is done and the download speed
                    
                }).on('error', (err) => {
                    console.error(err);
                    mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                    fileStream.close();
                    fs.unlinkSync(arg.path);
                    reject();
                });
                fileStream.on('data', (chunk) => {
                    // get the download speed
                    const downloadSpeed = chunk.length / 1024;
                    const progress = fileStream.bytesWritten / fileSize;
                    console.log("Progress: ", progress, " Download Speed: ", downloadSpeed);
                    mainWindow.webContents.send('ddl:download-progress', { id: downloadID, progress, downloadSpeed });
                });

                fileStream.on('error', (err) => {
                    console.error(err);
                    mainWindow.webContents.send('ddl:download-error', { id: downloadID, error: err });
                    fileStream.close();
                    reject()
                });

                fileStream.on('finish', () => {
                    console.log("Download complete!")
                    fileStream.close();
                    mainWindow.webContents.send('ddl:download-complete', { id: downloadID });
                    resolve();
                });
            }).then(() => {
                console.log('Download complete!!');
            }).catch((err) => {
                console.log('Download failed');
                console.error(err);
            });
            // stream the download 
            event.returnValue = downloadID;
        });

        mainWindow!!.show()
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
});

// Quit when all windows are closed.
app.on('window-all-closed', function () {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') app.quit()
});

app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) createWindow()
});
// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.