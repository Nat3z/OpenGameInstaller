import { join } from 'path';
import { server, port, clients } from "./server/addon-server.js"
import { applicationAddonSecret } from './server/constants.js';
import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron';
import fs, { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { processes, setupAddon, startAddon } from './addon-init-configure.js';
import os from 'os';
import axios from 'axios';
import { stopClient } from './webtorrent-connect.js';
import path from 'path';
import Fuse from 'fuse.js'
import { ConfigurationFile } from 'ogi-addon/build/config/ConfigurationBuilder.js';
import { LibraryInfo } from 'ogi-addon';
import { checkIfInstallerUpdateAvailable } from './updater.js';
import AppEventHandler from './handlers/app-handler.js';
import FSEventHandler from './handlers/fs-handler.js';
import RealdDebridHandler from './handlers/realdebrid-handler.js';
import TorrentHandler from './handlers/torrent-handler.js';
import DirectDownloadHandler from './handlers/direct-download.js';

export const VERSION = app.getVersion();

export let __dirname = isDev() ? app.getAppPath() + "/../development" : path.dirname(process.execPath);
if (process.platform === 'linux' && !isDev()) {
    // it's most likely sandboxed, so just use ./
    // check if the folder exists
    // get the home directory
    let home = os.homedir();
    if (!fs.existsSync(join(home, '.local/share/OpenGameInstaller'))) {
        fs.mkdirSync(join(home, '.local/share/OpenGameInstaller'), { recursive: true });
    }
    __dirname = join(home, '.local/share/OpenGameInstaller');
}

const OGI_DIRECTORY = process.env.OGI_DIRECTORY;
if (OGI_DIRECTORY)
    __dirname = OGI_DIRECTORY;

export let isSecurityCheckEnabled = true;
if (existsSync(join(__dirname, 'config/option/developer.json'))) {
  const developerConfig = JSON.parse(readFileSync(join(__dirname, 'config/option/developer.json'), 'utf-8'));
  isSecurityCheckEnabled = developerConfig.disableSecretCheck !== true;
  if (!isSecurityCheckEnabled) {
    for (let i = 0; i < 10; i++) {
      console.warn('WARNING Security check is disabled. THIS IS A MAJOR SECURITY RISK. PLEASE ENABLE DURING NORMAL USE.');
    }
  }
}
// check if NixOS using command -v nixos-rebuild
export const IS_NIXOS = await (() => {
    return new Promise<boolean>((resolve) => {
        try {
            exec('command -v nixos-rebuild', (error, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`);
                resolve(false);
                return;
            }
            if (stderr.includes("nixos-rebuild")) {
                resolve(true);
                return;
            }
                resolve(false);
            });
        } catch (error) {
            console.error(`exec error: ${error}`);
            resolve(false);
        }
    });
})();
console.log("continuing launch...")
export let STEAMTINKERLAUNCH_PATH = join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch');
async function fetch_STLPath() {
    return new Promise<void>((resolve) => {
        exec('which steamtinkerlaunch', (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`);
                return;
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
                return;
            }

            // The path will be returned as a string in stdout.
            const path = stdout.trim();  // Remove any extra newlines or spaces.
            STEAMTINKERLAUNCH_PATH = path;
            resolve();
        });
    });
}
console.log('NIXOS: ' + IS_NIXOS);
if (IS_NIXOS) await fetch_STLPath();
if (STEAMTINKERLAUNCH_PATH === '') {
    STEAMTINKERLAUNCH_PATH = join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch');
    console.error("STEAMTINKERLAUNCH_PATH is empty. Using default path to prevent issues.");
}

console.log('STEAMTINKERLAUNCH_PATH: ' + STEAMTINKERLAUNCH_PATH);
console.log("Running in directory: " + __dirname);

export let torrentIntervals: NodeJS.Timeout[] = []
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow: BrowserWindow | null;

function isDev() {
    return !app.isPackaged;
}

// restore the backup if it exists
if (fs.existsSync(join(app.getPath('temp'), 'ogi-update-backup')) && process.platform === 'win32') {
    // restore the backup
    const directory = join(app.getPath('temp'), 'ogi-update-backup');
    console.log('[backup] Restoring backup...');
    for (const file of fs.readdirSync(directory)) {
        console.log('[backup] Restoring ' + file);
        fs.cpSync(join(directory, file), join(__dirname, file), { recursive: true, force: true });
        console.log('[backup] Restored ' + file);
    }

    // remove the backup
    fs.rmdirSync(directory, { recursive: true });
    console.log('[backup] Backup restored successfully!');
}
let steamApps: { appid: number, name: string }[] = [];

export let steamAppSearcher: Fuse<{ appid: number, name: string }> | undefined;

async function getSteamApps(): Promise<{ appid: number, name: string }[]> {
    if (fs.existsSync(join(__dirname, 'steam-apps.json'))) {
        const steamApps: { timeSinceUpdate: number, data: { appid: number, name: string }[] } = JSON.parse(fs.readFileSync(join(__dirname, 'steam-apps.json'), 'utf-8'));
        if (Date.now() - steamApps.timeSinceUpdate < 86400000) { //24 hours
            return steamApps.data;
        }
    }
    const response = await axios.get('https://api.steampowered.com/ISteamApps/GetAppList/v0002/?key=STEAMKEY&format=json')
    const steamApps = response.data.applist.apps;
    fs.writeFileSync(join(__dirname, 'steam-apps.json'), JSON.stringify({ timeSinceUpdate: Date.now(), data: steamApps }, null, 2));
    return steamApps
}
// lazy tasks
new Promise<void>(async (resolve) => {
    steamApps = await getSteamApps();
    steamAppSearcher = new Fuse(steamApps, {
        keys: ['name', 'appid'],
        threshold: 0.3,
        includeScore: true
    });
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
            devTools: isDev(),
            preload: isDev() ? join(app.getAppPath(), 'preload.mjs') : join(app.getAppPath(), 'build/preload.mjs')
        },
        title: 'OpenGameInstaller',
        fullscreenable: false,
        resizable: false,
        icon: join(app.getAppPath(), 'public/favicon.ico'),
        autoHideMenuBar: true,
        show: false
    });
    if (!isDev())
        mainWindow.removeMenu();

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
    mainWindow.on('closed', function() {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        mainWindow = null
    });

    // Emitted when the window is ready to be shown
    // This helps in showing the window gracefully.
    fs.mkdir(join(__dirname, "config"), (_) => { });
    fs.mkdir(join(__dirname, "config"), (_) => { });
    mainWindow.once('ready-to-show', () => {
        AppEventHandler(mainWindow!!);
        FSEventHandler();
        RealdDebridHandler(mainWindow!!);
        TorrentHandler(mainWindow!!);
        DirectDownloadHandler(mainWindow!!);

        ipcMain.handle('install-addons', async (_, addons) => {
            // addons is an array of URLs to the addons to install. these should be valid git repositories
            // check if git is installed
            if (!fs.existsSync(join(__dirname, 'addons/'))) {
                fs.mkdirSync(join(__dirname, 'addons/'));
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
                let addonPath = join(__dirname, `addons/${addonName}`);
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
            restartAddonServer();
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
            fs.rmdirSync(join(__dirname, 'addons/'), { recursive: true });
            fs.mkdirSync(join(__dirname, 'addons/'));

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
            let requireRestart = false;
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
                        const fileStream = fs.createWriteStream(join(__dirname, '7z-install.exe'));
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
                                fs.unlinkSync(join(__dirname, '7z-install.exe'));
                                sendNotification({
                                    message: 'Successfully installed 7zip.',
                                    id: Math.random().toString(36).substring(7),
                                    type: 'info'
                                });
                                requireRestart = true;
                                resolve();
                            })
                        });

                        fileStream.on('error', (err) => {
                            console.error(err);
                            fileStream.close();
                            fs.unlinkSync(join(__dirname, '7z-install.exe'));
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
                    sendNotification({
                        message: "Git is not installed. Downloading git now.",
                        id: Math.random().toString(36).substring(7),
                        type: "info"
                    });
                    const gitDownload = "https://github.com/git-for-windows/git/releases/download/v2.46.0.windows.1/Git-2.46.0-64-bit.exe"
                    await new Promise<void>((resolve, reject) => axios({
                        method: 'get',
                        url: gitDownload,
                        responseType: 'stream'
                    }).then(response => {
                        const fileStream = fs.createWriteStream(join(__dirname, 'git-install.exe'));
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
                                fs.unlinkSync(join(__dirname, 'git-install.exe'));
                                sendNotification({
                                    message: 'Successfully installed git.',
                                    id: Math.random().toString(36).substring(7),
                                    type: 'info'
                                });
                                requireRestart = true;
                                resolve();
                            })
                        });

                        fileStream.on('error', (err) => {
                            console.error(err);
                            fileStream.close();
                            fs.unlinkSync(join(__dirname, 'git-install.exe'));
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
            if (process.platform === 'linux' && STEAMTINKERLAUNCH_PATH === join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch')) {
                if (!fs.existsSync(join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'))) {
                    await new Promise<void>((resolve, reject) => {
                        exec('git clone https://github.com/sonic2kk/steamtinkerlaunch ' + join(__dirname, 'bin/steamtinkerlaunch'), (err, stdout, stderr) => {
                            if (err) {
                                console.error(err);
                                reject();
                                cleanlyDownloadedAll = false;
                                return;
                            }
                            console.log(stdout);
                            console.log(stderr);
                            // run chmod +x on the file
                            exec('chmod +x ' + join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'), (err) => {
                                if (err) {
                                    console.error(err);
                                    reject();
                                    cleanlyDownloadedAll = false;
                                    return;
                                }

                                // now executing steamtinkerlaunch
                                exec(join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'), (err, stdout, stderr) => {
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
                        exec('git pull', { cwd: join(__dirname, 'bin/steamtinkerlaunch') }, (err, stdout, stderr) => {
                            if (err) {
                                console.error(err);
                                reject();
                                cleanlyDownloadedAll = false;
                                return;
                            }
                            console.log(stdout);
                            console.log(stderr);
                            // run chmod +x on the file
                            exec('chmod +x ' + join(__dirname, 'bin/steamtinkerlaunch/steamtinkerlaunch'), (err, stdout, stderr) => {
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
            } else if (process.platform === 'linux') {
                // check if steamtinkerlaunch is installed in that path
                if (!fs.existsSync(STEAMTINKERLAUNCH_PATH)) {
                    sendNotification({
                        message: 'SteamTinkerLaunch is not installed. You are not on a supported OS. Please install it manually.',
                        id: Math.random().toString(36).substring(7),
                        type: 'error'
                    });
                    cleanlyDownloadedAll = false;
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
                        requireRestart = true;
                        resolve();
                    }))
                }
                else if (process.platform === 'linux' && !IS_NIXOS) {
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
                                }); resolve(); requireRestart = true;

                            });

                        })
                    })
                }
                else if (process.platform === 'linux' && IS_NIXOS) {
                    sendNotification({
                        message: 'Bun is not installed. You are not on a supported OS. Please install it manually.',
                        id: Math.random().toString(36).substring(7),
                        type: 'error'
                    });
                    cleanlyDownloadedAll = false;
                }
            }
            else if (!IS_NIXOS) {
                await new Promise<void>((resolve) => exec('bun upgrade', (err, stdout, stderr) => {
                    if (err) {
                        console.error(err);
                        // reject();
                        resolve();
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

            return [cleanlyDownloadedAll, requireRestart];
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
            if (!fs.existsSync(join(__dirname, 'addons/'))) {
                return;
            }
            let addonsUpdated = 0;
            let failed = false;
            const generalConfig = JSON.parse(fs.readFileSync(join(__dirname, 'config/option/general.json'), 'utf-8'));
            const addons = generalConfig.addons as string[];

            for (const addon of addons) {
                let addonPath = '';
                if (addon.startsWith('local:')) {
                    addonPath = addon.split('local:')[1];
                }
                else {
                    addonPath = join(__dirname, 'addons', addon.split(/\/|\\/).pop()!!);
                }
                if (!fs.existsSync(join(addonPath, '.git'))) {
                    console.log(`Addon ${addon} is not a git repository`);
                    continue;
                }
                // get rid of the installation log
                if (fs.existsSync(addonPath + '/installation.log')) {
                    fs.unlinkSync(addonPath + '/installation.log');
                }

                new Promise<void>((resolve, reject) => {
                    exec(`git pull`, { cwd: addonPath }, (err, stdout, _) => {
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

                        mainWindow!!.webContents.send('addon:updated', addon);
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

        app.on('browser-window-focus', function() {
            globalShortcut.register("CommandOrControl+R", () => {
                console.log("CommandOrControl+R is pressed: Shortcut Disabled");
            });
            globalShortcut.register("F5", () => {
                console.log("F5 is pressed: Shortcut Disabled");
            });
        });

        app.on('browser-window-blur', function() {
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
    const libraryPath = join(__dirname, 'library/');
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
    if (!fs.existsSync(join(__dirname, 'addons'))) {
        return;
    }
    const generalConfig = JSON.parse(fs.readFileSync(join(__dirname, 'config/option/general.json'), 'utf-8'));
    const addons = generalConfig.addons;
    for (const addon of addons) {
        let addonPath = '';
        let addonName = addon.split(/\/|\\/).pop()!!;
        if (addon.startsWith('local:')) {
            addonPath = addon.split('local:')[1];
        }
        else {
            addonPath = join(__dirname, 'addons', addonName);
        }

        if (!fs.existsSync(addonPath + '/.git')) {
            console.log(`Addon ${addonName} is not a git repository`);
            continue;
        }

        new Promise<void>(async (resolve, _) => {
            const isUpdate = await checkForGitUpdates(addonPath)
            if (isUpdate) {
                sendNotification({
                    message: `Addon ${addonName} has updates.`,
                    id: Math.random().toString(36).substring(7),
                    type: 'info'
                });
                mainWindow!!.webContents.send('addon:update-available', addon);
                console.log(`Addon ${addonName} has updates.`);
                resolve();
            }
            console.log(`Addon ${addonName} is up to date.`);
            resolve();
        });
    }
}
// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
    // check updates for setup
    await checkIfInstallerUpdateAvailable();

    createWindow();
    server.listen(port, () => {
        console.log(`Addon Server is running on http://localhost:${port}`);
        console.log(`Server is being executed by electron!`)
    });

    setTimeout(() => {
        sendNotification({
            message: 'Addons Starting...',
            id: Math.random().toString(36).substring(7),
            type: 'success'
        });

        startAddons();
    }, 1500);

});

function startAddons() {
    // start all of the addons
    if (!fs.existsSync(join(__dirname, 'config/option/general.json'))) {
        return
    }

    const generalConfig = JSON.parse(fs.readFileSync(join(__dirname, 'config/option/general.json'), 'utf-8'));
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
app.on('window-all-closed', async function() {
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

app.on('activate', function() {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) createWindow()
});

