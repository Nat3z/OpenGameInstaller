import axios from 'axios';
import { net, ipcMain } from 'electron';
import { currentScreens, sendIPCMessage, sendNotification } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import { exec, execSync, spawn, spawnSync } from 'child_process';
import { LibraryInfo } from 'ogi-addon';
import { __dirname } from '../paths.js';
import { STEAMTINKERLAUNCH_PATH } from '../startup.js';
import { clients } from '../server/addon-server.js';
import { dirname } from 'path';

const grantAccessToPath = (path: string, rootPassword: string) =>
  new Promise<void>((resolve, reject) => {
    // Get the folder from the file path
    path = fs.lstatSync(path).isDirectory() ? path : dirname(path);
    try {
      const child = spawn(
        'sudo',
        [
          '-S',
          'flatpak',
          'override',
          'org.winehq.Wine',
          '--filesystem=' + path,
        ],
        {
          stdio: ['pipe', 'inherit', 'inherit'],
        }
      );

      // Write password to stdin immediately after spawning
      child.stdin?.write(rootPassword + '\n');
      child.stdin?.end();

      child.on('close', (code) => {
        console.log(`[flatpak] process exited with code ${code}`);
        resolve();
      });
      child.on('error', (error) => {
        console.error(error);
        reject(error);
      });
    } catch (error) {
      console.error(error);
      sendNotification({
        message: 'Failed to allow flatpak to access the proton path',
        id: Math.random().toString(36).substring(7),
        type: 'error',
      });
      reject(error);
    }
  });
export default function handler(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('app:close', () => {
    mainWindow?.close();
  });
  ipcMain.handle('app:minimize', () => {
    mainWindow?.minimize();
  });
  ipcMain.handle('app:axios', async (_, options) => {
    try {
      const response = await axios(options);
      return {
        data: response.data,
        status: response.status,
        success: response.status >= 200 && response.status < 300,
      };
    } catch (err) {
      return {
        data: err.response.data,
        status: err.response.status,
        success: false,
      };
    }
  });

  ipcMain.handle('app:get-os', () => {
    return process.platform;
  });
  ipcMain.handle('app:screen-input', async (_, data) => {
    currentScreens.set(data.id, data.data);
    return;
  });

  ipcMain.handle('app:is-online', async () => {
    return net.isOnline();
  });
  ipcMain.handle('app:launch-game', async (_, appid) => {
    if (!fs.existsSync(join(__dirname, 'library'))) {
      return;
    }
    if (!fs.existsSync(join(__dirname, 'internals'))) {
      fs.mkdirSync(join(__dirname, 'internals'));
    }
    if (!fs.existsSync(join(__dirname, 'library/' + appid + '.json'))) {
      return;
    }

    const appInfo: LibraryInfo = JSON.parse(
      fs.readFileSync(join(__dirname, 'library/' + appid + '.json'), 'utf-8')
    );
    let args = appInfo.launchArguments || '%command%';
    // replace %command% with the launch executable
    args = args.replace('%command%', `"${appInfo.launchExecutable}"`);
    console.log('Launching game with args: ' + args, 'in cwd: ' + appInfo.cwd);
    const spawnedItem = exec(args, {
      cwd: appInfo.cwd,
    });
    spawnedItem.on('error', (error) => {
      console.error(error);
      sendNotification({
        message: 'Failed to launch game',
        id: Math.random().toString(36).substring(7),
        type: 'error',
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
          type: 'error',
        });

        mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
        return;
      }

      mainWindow?.webContents.send('game:exit', { id: appInfo.appID });
    });

    mainWindow?.webContents.send('game:launch', { id: appInfo.appID });
  });

  ipcMain.handle('app:remove-app', async (_, appid: number) => {
    if (!fs.existsSync(join(__dirname, 'library'))) {
      return;
    }
    if (!fs.existsSync(join(__dirname, 'internals'))) {
      fs.mkdirSync(join(__dirname, 'internals'));
    }
    if (!fs.existsSync(join(__dirname, 'library/' + appid + '.json'))) {
      return;
    }
    fs.unlinkSync(join(__dirname, 'library/' + appid + '.json'));
    const appsInternal = JSON.parse(
      fs.readFileSync(join(__dirname, 'internals/apps.json'), 'utf-8')
    );
    const index = appsInternal.indexOf(appid);
    if (index > -1) {
      appsInternal.splice(index, 1);
    }
    fs.writeFileSync(
      join(__dirname, 'internals/apps.json'),
      JSON.stringify(appsInternal, null, 2)
    );
    return;
  });

  ipcMain.handle(
    'app:insert-app',
    async (
      _,
      data: LibraryInfo & {
        redistributables?: { name: string; path: string }[];
      }
    ): Promise<
      | 'setup-failed'
      | 'setup-success'
      | 'setup-redistributables-failed'
      | 'setup-redistributables-success'
    > => {
      if (!fs.existsSync(join(__dirname, 'library')))
        fs.mkdirSync(join(__dirname, 'library'));

      const appPath = join(__dirname, `library/${data.appID}.json`);
      fs.writeFileSync(appPath, JSON.stringify(data, null, 2));
      if (!fs.existsSync(join(__dirname, 'internals'))) {
        fs.mkdirSync(join(__dirname, 'internals'));
      }
      // write to the internal file
      if (!fs.existsSync(join(__dirname, 'internals/apps.json'))) {
        fs.writeFileSync(
          join(__dirname, 'internals/apps.json'),
          JSON.stringify([], null, 2)
        );
      }
      const appsInternal = JSON.parse(
        fs.readFileSync(join(__dirname, 'internals/apps.json'), 'utf-8')
      );

      appsInternal.push(data.appID);
      fs.writeFileSync(
        join(__dirname, 'internals/apps.json'),
        JSON.stringify(appsInternal, null, 2)
      );

      if (process.platform === 'linux') {
        // make the launch executable use / instead of \
        data.launchExecutable = data.launchExecutable.replaceAll('\\', '/');
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        const protonPath = `${homeDir}/.ogi-wine-prefixes/${data.appID}`;
        // if the proton path does not exist, create it
        if (!fs.existsSync(protonPath)) {
          fs.mkdirSync(protonPath, { recursive: true });
        }

        // if there are redistributables, we need to install them

        if (data.redistributables) {
          let rootPassword = '';
          // firstly, allow the flatpak to access the proton path
          const rootPasswordGranter = () =>
            new Promise<void>((resolve) => {
              sendIPCMessage('app:ask-root-password', true);
              ipcMain.handleOnce(
                'app:root-password-granted',
                async (_, password) => {
                  // allow the flatpak to access the proton path
                  try {
                    execSync(`echo -e "${password}\n" | sudo -S -k true`, {
                      stdio: 'ignore',
                    });
                    await grantAccessToPath(protonPath, password);
                    rootPassword = password;
                    resolve();
                  } catch (error) {
                    console.error(error);
                    sendNotification({
                      message:
                        'Failed to allow flatpak to access the proton path.',
                      id: Math.random().toString(36).substring(7),
                      type: 'error',
                    });
                    await rootPasswordGranter();
                    resolve();
                  }
                }
              );
            });
          await rootPasswordGranter();

          for (const redistributable of data.redistributables) {
            try {
              sendNotification({
                message: `Installing ${redistributable.name} for ${data.name}`,
                id: Math.random().toString(36).substring(7),
                type: 'info',
              });

              await grantAccessToPath(redistributable.path, rootPassword);
              console.log('Running destributable: ' + redistributable.path);
              await new Promise<void>((resolve) => {
                const command = 'flatpak';
                const args = [
                  'run',
                  `--env="WINEPREFIX=${protonPath}"`,
                  'org.winehq.Wine',
                  redistributable.path,
                ];
                const child = spawn(command, args, {
                  stdio: 'inherit',
                });

                child.on('close', (code) => {
                  console.log(
                    `[redistributable] process exited with code ${code}`
                  );
                  resolve();
                });

                child.on('error', (error) => {
                  console.error(
                    `[redistributable] failed to start process: ${error}`
                  );
                  resolve();
                });
              });

              sendNotification({
                message: `Installed ${redistributable.name} for ${data.name}`,
                id: Math.random().toString(36).substring(7),
                type: 'success',
              });
            } catch (error) {
              console.error(
                `[redistributable] failed to install ${redistributable.name} for ${data.name}: ${error}`
              );
              sendNotification({
                message: `Failed to install ${redistributable.name} for ${data.name}`,
                id: Math.random().toString(36).substring(7),
                type: 'error',
              });
            }
          }
          sendNotification({
            message: `Installed redistributables for ${data.name}`,
            id: Math.random().toString(36).substring(7),
            type: 'success',
          });
        }

        // use steamtinkerlaunch to add the game to steam
        const result = await new Promise<boolean>((resolve) =>
          exec(
            `${STEAMTINKERLAUNCH_PATH} addnonsteamgame --appname="${data.name}" --exepath="${data.launchExecutable}" --startdir="${data.cwd}" --launchoptions="STEAM_COMPAT_DATA_PATH=${protonPath} ${data.launchArguments ?? ''}" --compatibilitytool="proton_experimental" --use-steamgriddb`,
            {
              cwd: __dirname,
            },
            (error, stdout, stderr) => {
              if (error) {
                console.error(error);
                sendNotification({
                  message: 'Failed to add game to Steam',
                  id: Math.random().toString(36).substring(7),
                  type: 'error',
                });
                resolve(false);
                return;
              }
              console.log(stdout);
              console.log(stderr);
              sendNotification({
                message: 'Game added to Steam',
                id: Math.random().toString(36).substring(7),
                type: 'success',
              });
              resolve(true);
            }
          )
        );
        if (!result) {
          return 'setup-redistributables-failed';
        }
      } else if (process.platform === 'win32') {
        // if there are redistributables, we need to install them
        if (data.redistributables) {
          for (const redistributable of data.redistributables) {
            try {
              spawnSync(redistributable.path, {
                stdio: 'inherit',
                shell: true,
              });
              sendNotification({
                message: `Installed ${redistributable.name} for ${data.name}`,
                id: Math.random().toString(36).substring(7),
                type: 'success',
              });
            } catch (error) {
              console.error(
                `[redistributable] failed to install ${redistributable.name} for ${data.name}: ${error}`
              );
            }
          }
        }
      }
      return 'setup-success';
    }
  );
  ipcMain.handle('app:get-all-apps', async () => {
    if (!fs.existsSync(join(__dirname, 'library'))) {
      return [];
    }
    const files = fs.readdirSync(join(__dirname, 'library'));
    const apps: LibraryInfo[] = [];
    for (const file of files) {
      const data = fs.readFileSync(join(__dirname, `library/${file}`), 'utf-8');
      apps.push(JSON.parse(data));
    }
    return apps;
  });
  ipcMain.handle('app:get-addon-path', async (_, addonID: string) => {
    let client = clients.get(addonID);
    if (!client || !client.filePath) {
      return null;
    }
    return client.filePath;
  });
  ipcMain.handle('app:get-addon-icon', async (_, addonID: string) => {
    let client = clients.get(addonID);
    if (!client || !client.filePath) {
      return null;
    }
    // read the addon.json file to get the icon path
    const addonJson = JSON.parse(
      fs.readFileSync(join(client.filePath, 'addon.json'), 'utf-8')
    );
    if (!addonJson.icon) {
      return null;
    }
    const iconPath = join(client.filePath, addonJson.icon);
    if (!fs.existsSync(iconPath)) {
      console.error(
        'No icon path found for addon (does not exist): ' +
          addonID +
          ' at path: ' +
          iconPath
      );
      return null;
    }
    return iconPath;
  });
  ipcMain.handle('app:get-local-image', async (_, path: string) => {
    if (!fs.existsSync(path)) {
      return null;
    }
    const ext = path.split('.').pop()?.toLowerCase() || 'png';

    const mimeType =
      {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        svg: 'image/svg+xml',
      }[ext] || 'image/png';
    try {
      const buffer = fs.readFileSync(path);
      const base64 = buffer.toString('base64');
      return `data:${mimeType};base64,${base64}`;
    } catch (err) {
      console.error('Failed to read image file: ' + path);
      return null;
    }
  });
}
