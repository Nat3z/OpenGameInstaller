import axios from 'axios';
import { net, ipcMain, app } from 'electron';
import { currentScreens, sendNotification } from '../main.js';
import { join } from 'path';
import * as fs from 'fs';
import { exec, spawn, spawnSync } from 'child_process';
import { LibraryInfo } from 'ogi-addon';
import { __dirname, isDev } from '../manager/manager.paths.js';
import { STEAMTINKERLAUNCH_PATH } from '../startup.js';
import { clients } from '../server/addon-server.js';
import { dirname, basename } from 'path';
import * as os from 'os';
import * as path from 'path';
import { createReadStream, createWriteStream } from 'fs';

/**
 * Escapes a string for safe use in shell commands by escaping special characters
 */
const escapeShellArg = (arg: string): string => {
  // Replace any backslashes first (to avoid double-escaping)
  // Then escape double quotes, dollar signs, backticks, and backslashes
  return arg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
};

const getSilentInstallFlags = (
  filePath: string,
  fileName: string
): string[] => {
  const lowerFileName = fileName.toLowerCase();
  const lowerFilePath = filePath.toLowerCase();

  // Microsoft Visual C++ Redistributables
  if (
    lowerFileName.includes('vcredist') ||
    lowerFileName.includes('vc_redist')
  ) {
    return ['/S', '/v/qn']; // /S for silent, /v/qn for very quiet
  }

  // DirectX redistributables
  if (
    lowerFileName.includes('directx') ||
    lowerFileName.includes('dxwebsetup')
  ) {
    return ['/S'];
  }

  // .NET Framework redistributables
  if (lowerFileName.includes('dotnet') || lowerFileName.includes('netfx')) {
    // Special case for .NET Framework Repair Tool
    if (lowerFileName.includes('netfxrepairtool')) {
      return ['/p']; // Use /p flag for repair tool as requested
    }
    return ['/S', '/v/qn'];
  }

  // MSI installers
  if (lowerFileName.endsWith('.msi')) {
    return ['/S', '/qn']; // /qn = quiet no UI
  }

  // NSIS installers
  if (lowerFilePath.includes('nsis') || lowerFileName.includes('setup')) {
    return ['/S'];
  }

  // Inno Setup installers
  if (lowerFileName.includes('inno')) {
    return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
  }

  // InstallShield installers
  if (lowerFileName.includes('installshield')) {
    return ['/S', '/v/qn'];
  }

  // Default fallback - try multiple common flags
  return ['/S'];
};

export async function addToDesktop() {
  if (process.platform === 'win32') {
    return {
      success: false,
      error: 'This feature is only available on Linux',
    };
  }
  let appDirpath = isDev()
    ? app.getAppPath() + '/../'
    : path.dirname(process.execPath);
  if (process.platform === 'linux') {
    // it's most likely sandboxed, so just use ./
    appDirpath = './';
  }

  // get the appimage path
  let execPath =
    path.resolve(
      appDirpath,
      fs.readdirSync(appDirpath).find((file) => file.endsWith('.AppImage')) ||
        './OpenGameInstaller.AppImage'
    ) ?? './OpenGameInstaller.AppImage';

  try {
    const desktopDir = path.join(os.homedir(), 'Desktop');
    const desktopFilePath = path.join(desktopDir, 'OpenGameInstaller.desktop');

    // Ensure Desktop directory exists
    if (!fs.existsSync(desktopDir)) {
      fs.mkdirSync(desktopDir, { recursive: true });
    }

    // Get executable path
    const setupAppImagePath = path.resolve(
      path.resolve(appDirpath, '..'),
      'OpenGameInstaller-Setup.AppImage'
    );
    if (fs.existsSync(setupAppImagePath)) {
      execPath = setupAppImagePath;
    }

    // Get icon path (try to find favicon.png in resources)
    let iconPathForFavicon = '';
    if (app.isPackaged) {
      iconPathForFavicon = path.join(
        app.getPath('exe'),
        '..',
        'opengameinstaller-gui.png'
      );
    } else {
      // In development, use the public folder
      iconPathForFavicon = path.join(
        __dirname,
        '..',
        '..',
        'public',
        'favicon.png'
      );
    }

    // dump the icon path into the appdirpath/favicon.png
    if (iconPathForFavicon) {
      createReadStream(iconPathForFavicon).pipe(
        createWriteStream(path.join(appDirpath, 'favicon.png'))
      );
    }

    // now turn the path into an absolute path
    let desktopIconPath = path.resolve(appDirpath, 'favicon.png');
    console.log('Desktop icon path:', desktopIconPath);

    // Create .desktop file content
    const desktopContent = `[Desktop Entry]
Type=Application
Name=OpenGameInstaller
Exec=${execPath}
Path=${execPath.endsWith('-Setup.AppImage') ? path.resolve(appDirpath, '..') : appDirpath}
Icon=${desktopIconPath}
Terminal=false
Categories=Game;
StartupNotify=true
`;

    // Write the .desktop file
    fs.writeFileSync(desktopFilePath, desktopContent, { mode: 0o755 });

    return {
      success: true,
      path: desktopFilePath,
    };
  } catch (error: any) {
    console.error('Failed to create desktop shortcut:', error);
    return {
      success: false,
      error: error.message || 'Failed to create desktop shortcut',
    };
  }
}

export default function handler(mainWindow: Electron.BrowserWindow) {
  ipcMain.handle('app:close', () => {
    mainWindow?.close();
  });
  ipcMain.handle('app:minimize', () => {
    mainWindow?.minimize();
  });
  ipcMain.handle('app:axios', async (_, options) => {
    if (
      options.data &&
      options.headers &&
      (options.headers['Content-Type'] === 'multipart/form-data' ||
        options.headers['Content-Type'] === 'application/x-www-form-urlencoded')
    ) {
      const formData = new FormData();
      for (const [key, value] of Object.entries(options.data)) {
        formData.append(key, value as string);
      }
      options.data = formData;
    }
    console.log('app:axios', options);
    try {
      const response = await axios(options);
      return {
        data: response.data,
        status: response.status,
        success: response.status >= 200 && response.status < 300,
      };
    } catch (err: any) {
      return {
        data: err?.response?.data ?? err?.message ?? err,
        status: err?.response?.status ?? 500,
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
    args = args.replace(
      '%command%',
      `"${escapeShellArg(appInfo.launchExecutable)}"`
    );
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
      | 'setup-prefix-required'
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

      // linux case
      if (process.platform === 'linux') {
        // make the launch executable use / instead of \
        data.launchExecutable = data.launchExecutable.replace(/\\/g, '/');

        // Determine if we need to set up wine prefix for redistributables
        const hasRedistributables =
          data.redistributables && data.redistributables.length > 0;

        // Add game to Steam first via steamtinkerlaunch
        const launchOptions = hasRedistributables
          ? `${data.launchArguments ?? ''}`
          : (data.launchArguments ?? '');

        const result = await new Promise<boolean>((resolve) =>
          exec(
            `${STEAMTINKERLAUNCH_PATH} addnonsteamgame --appname="${escapeShellArg(data.name)}" --exepath="${escapeShellArg(data.launchExecutable)}" --startdir="${escapeShellArg(data.cwd)}" --launchoptions="${escapeShellArg(launchOptions)}" --compatibilitytool="proton_experimental" --use-steamgriddb`,
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

        // add to the {appid}.json file the launch options
        const { success, appId: steamAppId } = await getNonSteamGameAppID(
          data.name
        );
        if (!success) {
          return 'setup-failed';
        }
        const protonPath = `${process.env.HOME}/.steam/steam/steamapps/compatdata/${steamAppId}/pfx`;
        data.launchArguments = 'WINEPREFIX=' + protonPath + ' ' + launchOptions;
        fs.writeFileSync(appPath, JSON.stringify(data, null, 2));

        if (!result) {
          return 'setup-failed';
        }

        // If there are redistributables, we need to wait for the user to create the Proton prefix
        // by launching the game through Steam. Return a special status to trigger the UI flow.
        if (hasRedistributables) {
          console.log(
            '[setup] Redistributables detected. Returning setup-prefix-required status.'
          );
          console.log(
            '[setup] User needs to restart Steam and launch the game to create Proton prefix.'
          );

          // Re-save the data with redistributables preserved for later installation
          fs.writeFileSync(appPath, JSON.stringify(data, null, 2));

          return 'setup-prefix-required';
        }
      } else if (process.platform === 'win32') {
        // if there are redistributables, we need to install them
        if (data.redistributables && data.redistributables.length > 0) {
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

  ipcMain.handle(
    'app:update-app-version',
    async (
      _,
      data: {
        appID: number;
        version: string;
        cwd: string;
        launchExecutable: string;
        launchArguments?: string;
      }
    ) => {
      const appPath = join(__dirname, `library/${data.appID}.json`);
      if (!fs.existsSync(appPath)) {
        return 'app-not-found';
      }
      const appData = JSON.parse(fs.readFileSync(appPath, 'utf-8'));
      appData.version = data.version;
      appData.cwd = data.cwd;
      appData.launchExecutable = data.launchExecutable;
      appData.launchArguments = data.launchArguments;
      fs.writeFileSync(appPath, JSON.stringify(appData, null, 2));
      return 'success';
    }
  );

  ipcMain.handle('app:add-to-steam', async (_, appID: number) => {
    if (process.platform !== 'linux') {
      return { success: false, error: 'Only available on Linux' };
    }

    if (!fs.existsSync(join(__dirname, 'library'))) {
      return { success: false, error: 'Library directory not found' };
    }

    const appPath = join(__dirname, `library/${appID}.json`);
    if (!fs.existsSync(appPath)) {
      return { success: false, error: 'Game not found' };
    }

    const appInfo: LibraryInfo = JSON.parse(fs.readFileSync(appPath, 'utf-8'));
    let launchOptions = appInfo.launchArguments ?? '';

    // remove any wineprefix=..... from the launch options
    launchOptions = launchOptions.replace(/WINEPREFIX=.*? /g, '').trim();

    // Use steamtinkerlaunch to add the game to steam
    const result = await new Promise<boolean>((resolve) =>
      exec(
        `${STEAMTINKERLAUNCH_PATH} addnonsteamgame --appname="${escapeShellArg(appInfo.name)}" --exepath="${escapeShellArg(appInfo.launchExecutable)}" --startdir="${escapeShellArg(appInfo.cwd)}" --launchoptions="${escapeShellArg(launchOptions)}" --compatibilitytool="proton_experimental" --use-steamgriddb`,
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

    return { success: result };
  });

  const cachedAppIds: Record<string, number> = {};
  // Get the Steam App ID for a non-Steam game using steamtinkerlaunch
  // Output format from STL: "<appid>\t(<game name>)" or "<appid> (<game name>)"
  function getNonSteamGameAppID(
    gameName: string
  ): Promise<{ success: boolean; appId?: number; error?: string }> {
    return new Promise((resolve) => {
      if (cachedAppIds[gameName]) {
        resolve({ success: true, appId: cachedAppIds[gameName] });
        return;
      }
      exec(
        `${STEAMTINKERLAUNCH_PATH} getid "${escapeShellArg(gameName)}"`,
        { cwd: __dirname },
        (error, stdout, _stderr) => {
          if (error) {
            console.error('[getNonSteamGameAppID] Error:', error);
            resolve({ success: false, error: error.message });
            return;
          }

          // Parse the output - extract just the numbers (appid)
          // Output format: "Preparing to installSteamTinkerLaunch...\njefopwejfoew\nfijwepfjoeww\n....\n<appid><tab or space>(<game name>)"
          const output = stdout.trim();
          const appIdLine = output
            .split('\n')
            .find((line) => line.includes('(' + gameName + ')'));
          if (!appIdLine) {
            console.error(
              '[getNonSteamGameAppID] Could not find app ID for game:',
              gameName
            );
            resolve({
              success: false,
              error: 'Could not find app ID for game',
            });
            return;
          }
          const appId = parseInt(appIdLine.split('(')[0].trim());
          console.log(
            `[getNonSteamGameAppID] Found app ID ${appId} for "${gameName}"`
          );
          resolve({ success: true, appId });
          cachedAppIds[gameName] = appId;
        }
      );
    });
  }

  // === Steam Process Management Handlers ===

  ipcMain.handle('app:kill-steam', async () => {
    if (process.platform !== 'linux') {
      return { success: false, error: 'Only available on Linux' };
    }

    console.log('[steam] Attempting to kill Steam process...');

    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      // Try pkill first, then killall as fallback
      exec('steam -shutdown', (error) => {
        if (error) {
          // pkill returns non-zero if no process found, try killall
          exec('killall steam', (error2) => {
            if (error2) {
              console.log('[steam] No Steam process found to kill');
              // Not an error - Steam might not be running
              resolve({ success: true });
            } else {
              console.log('[steam] Steam process killed via killall');
              resolve({ success: true });
            }
          });
        } else {
          console.log('[steam] Steam process killed via pkill');
          resolve({ success: true });
        }
      });
    });
  });

  ipcMain.handle('app:start-steam', async () => {
    if (process.platform !== 'linux') {
      return { success: false, error: 'Only available on Linux' };
    }

    console.log('[steam] Starting Steam...');

    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      // Launch Steam detached so it doesn't block
      const child = spawn('steam', [], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();

      // Give Steam a moment to start
      setTimeout(() => {
        console.log('[steam] Steam launch command executed');
        resolve({ success: true });
      }, 1000);
    });
  });

  ipcMain.handle('app:launch-steam-app', async (_, appID: number) => {
    if (process.platform !== 'linux') {
      return { success: false, error: 'Only available on Linux' };
    }

    const appPath = join(__dirname, `library/${appID}.json`);
    if (!fs.existsSync(appPath)) {
      return { success: false, error: 'Game not found' };
    }

    const appInfo: LibraryInfo = JSON.parse(fs.readFileSync(appPath, 'utf-8'));

    // Get the Steam shortcut ID
    const { success, appId } = await getNonSteamGameAppID(appInfo.name);
    if (!success) {
      return { success: false, error: 'Failed to get Steam shortcut ID' };
    }

    console.log(
      `[steam] Launching app via Steam: ${appInfo.name} (shortcut ID: ${appId})`
    );

    return new Promise<{
      success: boolean;
      shortcutId?: number;
      error?: string;
    }>((resolve) => {
      // Use xdg-open to open the steam:// URL
      exec(`xdg-open steam://rungameid/${appId}`, (error) => {
        if (error) {
          console.error('[steam] Failed to launch app via Steam:', error);
          resolve({ success: false, error: error.message });
        } else {
          console.log('[steam] Steam app launch command executed');
          resolve({ success: true, shortcutId: appId });
        }
      });
    });
  });

  ipcMain.handle('app:check-prefix-exists', async (_, appID: number) => {
    if (process.platform !== 'linux') {
      return { exists: false, error: 'Only available on Linux' };
    }
    let libraryInfo: LibraryInfo;
    const appPath = join(__dirname, `library/${appID}.json`);
    if (!fs.existsSync(appPath)) {
      return { exists: false, error: 'Game not found' };
    }
    libraryInfo = JSON.parse(fs.readFileSync(appPath, 'utf-8'));

    const { success, appId } = await getNonSteamGameAppID(libraryInfo.name);
    let homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) {
      return { exists: false, error: 'Home directory not found' };
    }
    if (!success) {
      return { exists: false, error: 'Failed to get Steam shortcut ID' };
    }
    const prefixPath = `${homeDir}/.steam/steam/steamapps/compatdata/${appId}/pfx`;
    const exists = fs.existsSync(prefixPath);
    console.log(
      `[prefix] Checking prefix for appID ${appID}: ${exists ? 'exists' : 'not found'} at ${prefixPath}`
    );

    return { exists, prefixPath };
  });

  ipcMain.handle(
    'app:install-redistributables',
    async (_, appID: number): Promise<'success' | 'failed' | 'not-found'> => {
      if (process.platform !== 'linux') {
        return 'failed';
      }

      const appPath = join(__dirname, `library/${appID}.json`);
      if (!fs.existsSync(appPath)) {
        return 'not-found';
      }

      const appInfo: LibraryInfo & {
        redistributables?: { name: string; path: string }[];
      } = JSON.parse(fs.readFileSync(appPath, 'utf-8'));

      if (!appInfo.redistributables || appInfo.redistributables.length === 0) {
        console.log('[redistributable] No redistributables to install');
        return 'success';
      }

      const homeDir = process.env.HOME || process.env.USERPROFILE;
      const protonBasePath = `${homeDir}/.steam/steam/steamapps/compatdata`;
      const { success, appId } = await getNonSteamGameAppID(appInfo.name);
      if (!success) {
        return 'failed';
      }
      const protonPath = `${protonBasePath}/${appId}/pfx`;

      // Check if the prefix exists
      if (!fs.existsSync(protonPath)) {
        console.error(
          '[redistributable] Proton prefix does not exist:',
          protonPath
        );
        sendNotification({
          message:
            'Proton prefix not found. Please launch the game through Steam first.',
          id: Math.random().toString(36).substring(7),
          type: 'error',
        });
        return 'failed';
      }

      console.log(
        `[redistributable] Installing ${appInfo.redistributables.length} redistributables for ${appInfo.name}`
      );

      // Install redistributables using winetricks/flatpak wine
      for (const redistributable of appInfo.redistributables) {
        try {
          sendNotification({
            message: `Installing ${redistributable.name} for ${appInfo.name}`,
            id: Math.random().toString(36).substring(7),
            type: 'info',
          });

          console.log(
            '[redistributable] Installing:',
            redistributable.name,
            redistributable.path
          );

          const success = await new Promise<boolean>(async (resolve) => {
            if (
              redistributable.path === 'microsoft' &&
              redistributable.name === 'dotnet-repair'
            ) {
              // Download and run the .NET Framework Repair Tool
              console.log(
                '[dotnet-repair] Starting .NET Framework Repair Tool'
              );
              const netfxRepairToolUrl =
                'https://download.microsoft.com/download/2/b/d/2bde5459-2225-48b8-830c-ae19caf038f1/NetFxRepairTool.exe';
              const toolPath = join(__dirname, 'bin', 'NetFxRepairTool.exe');

              // Create the bin directory if it doesn't exist
              if (!fs.existsSync(join(__dirname, 'bin'))) {
                fs.mkdirSync(join(__dirname, 'bin'));
              }

              try {
                // Download the tool if it doesn't exist
                if (!fs.existsSync(toolPath)) {
                  console.log(
                    '[dotnet-repair] Downloading .NET Framework Repair Tool...'
                  );
                  const response = await axios({
                    method: 'get',
                    url: netfxRepairToolUrl,
                    responseType: 'stream',
                  });

                  const fileStream = fs.createWriteStream(toolPath);
                  response.data.pipe(fileStream);

                  await new Promise<void>((downloadResolve, downloadReject) => {
                    fileStream.on('finish', () => {
                      fileStream.close();
                      console.log('[dotnet-repair] Download completed');
                      downloadResolve();
                    });
                    fileStream.on('error', (err) => {
                      console.error('[dotnet-repair] Download error:', err);
                      fileStream.close();
                      try {
                        fs.unlinkSync(toolPath);
                      } catch (unlinkErr) {
                        console.error(
                          '[dotnet-repair] Failed to cleanup file:',
                          unlinkErr
                        );
                      }
                      downloadReject(err);
                    });
                  });
                }

                // Run the tool with wine and /p flag
                console.log(
                  '[dotnet-repair] Running .NET Framework Repair Tool with wine'
                );
                const child = spawn(
                  'flatpak',
                  [
                    `--env=WINEPREFIX=${protonPath}`,
                    `--env=DISPLAY=:0`,
                    `--env=WINEDEBUG=-all`,
                    `--env=WINEDLLOVERRIDES=mscoree,mshtml=`,
                    '--filesystem=host',
                    'run',
                    'org.winehq.Wine',
                    'bin/NetFxRepairTool.exe',
                    '/p',
                  ],
                  {
                    stdio: ['inherit', 'pipe', 'pipe'],
                    cwd: __dirname,
                  }
                );

                child.on('close', (code) => {
                  console.log(
                    `[dotnet-repair] process exited with code ${code}`
                  );
                  resolve(code === 0);
                });

                child.on('error', (error) => {
                  console.error('[dotnet-repair] Process error:', error);
                  resolve(false);
                });

                // Set timeout (5 minutes for repair tool)
                setTimeout(
                  () => {
                    if (child.pid) {
                      child.kill('SIGTERM');
                    }
                    resolve(false);
                  },
                  5 * 60 * 1000
                );
              } catch (error) {
                console.error('[dotnet-repair] Error:', error);
                resolve(false);
              }
            } else if (redistributable.path === 'winetricks') {
              // Use winetricks via flatpak
              const child = spawn(
                'flatpak',
                [
                  `--env=WINEPREFIX=${protonPath}`,
                  `--env=DISPLAY=:0`,
                  `--env=WINEDEBUG=-all`,
                  `--env=WINEDLLOVERRIDES=mscoree,mshtml=`,
                  '--filesystem=host',
                  '--command=winetricks',
                  'run',
                  'org.winehq.Wine',
                  redistributable.name,
                  '--force',
                  '--unattended',
                  '-q',
                ],
                {
                  stdio: ['inherit', 'pipe', 'pipe'],
                  cwd: __dirname,
                }
              );

              child.on('close', (code) => {
                console.log(`[winetricks] process exited with code ${code}`);
                resolve(code === 0);
              });

              child.on('error', (error) => {
                console.error('[winetricks] Process error:', error);
                resolve(false);
              });

              // Set timeout
              setTimeout(
                () => {
                  if (child.pid) {
                    child.kill('SIGTERM');
                  }
                  resolve(false);
                },
                10 * 60 * 1000
              );
            } else {
              // Regular redistributable file
              const redistributablePath = redistributable.path
                .trim()
                .replace(/\n$/g, '');
              const redistributableDir = dirname(redistributablePath);
              const redistributableFilename = basename(redistributablePath);

              const silentFlags = getSilentInstallFlags(
                redistributablePath,
                redistributableFilename
              );

              const child = spawn(
                'flatpak',
                [
                  `--env=WINEPREFIX=${protonPath}`,
                  `--env=DISPLAY=:0`,
                  `--env=WINEDEBUG=-all`,
                  `--env=WINEDLLOVERRIDES=mscoree,mshtml=`,
                  '--filesystem=host',
                  'run',
                  'org.winehq.Wine',
                  redistributableFilename,
                  ...silentFlags,
                ],
                {
                  stdio: ['ignore', 'pipe', 'pipe'],
                  cwd: redistributableDir,
                }
              );

              child.on('close', (code) => {
                console.log(
                  `[redistributable] process exited with code ${code}`
                );
                resolve(code === 0);
              });

              child.on('error', (error) => {
                console.error('[redistributable] Process error:', error);
                resolve(false);
              });

              // Set timeout
              setTimeout(
                () => {
                  if (child.pid) {
                    child.kill('SIGTERM');
                  }
                  resolve(false);
                },
                10 * 60 * 1000
              );
            }
          });

          if (success) {
            sendNotification({
              message: `Installed ${redistributable.name} for ${appInfo.name}`,
              id: Math.random().toString(36).substring(7),
              type: 'success',
            });
          } else {
            sendNotification({
              message: `Failed to install ${redistributable.name} for ${appInfo.name}`,
              id: Math.random().toString(36).substring(7),
              type: 'error',
            });
          }
        } catch (error) {
          console.error(
            `[redistributable] Error installing ${redistributable.name}:`,
            error
          );
          sendNotification({
            message: `Failed to install ${redistributable.name} for ${appInfo.name}`,
            id: Math.random().toString(36).substring(7),
            type: 'error',
          });
        }
      }

      // Clear redistributables from the library file after installation
      delete appInfo.redistributables;
      fs.writeFileSync(appPath, JSON.stringify(appInfo, null, 2));

      sendNotification({
        message: `Finished installing redistributables for ${appInfo.name}`,
        id: Math.random().toString(36).substring(7),
        type: 'success',
      });

      return 'success';
    }
  );

  ipcMain.handle('app:add-to-desktop', async () => {
    return await addToDesktop();
  });
}
