import axios from 'axios';
import { net, ipcMain } from 'electron';
import { currentScreens, sendIPCMessage, sendNotification } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { LibraryInfo } from 'ogi-addon';
import { __dirname } from '../paths.js';
import { STEAMTINKERLAUNCH_PATH } from '../startup.js';
import { clients } from '../server/addon-server.js';

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
        // use steamtinkerlaunch to add the game to steam
        const result = await new Promise<boolean>((resolve) =>
          exec(
            `${STEAMTINKERLAUNCH_PATH} addnonsteamgame --appname="${data.name}" --exepath="${data.launchExecutable}" --startdir="${data.cwd}" --launchoptions=${data.launchArguments ?? ''} --compatibilitytool="proton_experimental" --use-steamgriddb`,
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

        // if there are redistributables, we need to install them

        if (data.redistributables) {
          // get the compatdata path firstly
          // tell the user that we need them to launch the game on steam to generate the compatdata path
          sendNotification({
            message:
              'Please launch the game on Steam to generate the compatdata path',
            id: Math.random().toString(36).substring(7),
            type: 'info',
          });
          // the boolean is if it should be open
          sendIPCMessage('app:open-steam-compatdata', true);
          const compatdataPath = await new Promise<string | null>((resolve) =>
            exec(
              `${STEAMTINKERLAUNCH_PATH} getcompatdata "${data.name}" | tail -n 1`,
              (error, stdout, stderr) => {
                if (error) {
                  console.error(error);
                  resolve(null);
                  return;
                }
                // check if the stdout contains "no" and if so resolve null
                if (
                  stdout.includes('no compatdata ') ||
                  stderr.includes('no compatdata ')
                ) {
                  resolve(null);
                  return;
                }
                const compatdata = stdout.split(' -> ')[1]?.trim();
                resolve(compatdata);
              }
            )
          );

          if (!compatdataPath) {
            return 'setup-redistributables-failed';
          }

          for (const redistributable of data.redistributables) {
            try {
              sendNotification({
                message: `Installing ${redistributable.name} for ${data.name}`,
                id: Math.random().toString(36).substring(7),
                type: 'info',
              });
              await new Promise<void>((resolve) => {
                const command = 'flatpak';
                const args = [
                  'run',
                  `--env=WINEPREFIX=${compatdataPath}`,
                  '--command=winetricks',
                  'org.winehq.Wine',
                  join(redistributable.path),
                ];
                const child = spawn(command, args);

                child.stdout.on('data', (data) => {
                  console.log(`[winetricks stdout]: ${data}`);
                });

                child.stderr.on('data', (data) => {
                  console.log(`[winetricks stderr]: ${data}`);
                });

                child.on('close', (code) => {
                  console.log(`[winetricks] process exited with code ${code}`);
                  resolve();
                });

                child.on('error', (error) => {
                  console.error(
                    `[winetricks] failed to start process: ${error}`
                  );
                  resolve();
                });
              });
            } catch (error) {
              console.error(
                `[winetricks] failed to install ${redistributable.name} for ${data.name}: ${error}`
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
