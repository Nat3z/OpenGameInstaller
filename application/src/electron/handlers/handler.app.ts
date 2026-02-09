import axios from 'axios';
import { net, ipcMain, app } from 'electron';
import { currentScreens } from '../main.js';
import * as fs from 'fs';
import { join } from 'path';
import * as os from 'os';
import * as path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { isDev } from '../manager/manager.paths.js';
import { __dirname } from '../manager/manager.paths.js';
import { clients } from '../server/addon-server.js';
import { registerSteamHandlers } from './steam-handlers.js';
import { registerLibraryHandlers } from './library-handlers.js';
import { registerRedistributableHandlers } from './redistributable-handlers.js';

/**
 * Escapes a string for safe use in shell commands by escaping special characters
 */
export function escapeShellArg(arg: string): string {
  // Replace any backslashes first (to avoid double-escaping)
  // Then escape double quotes, dollar signs, backticks, and backslashes
  return arg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

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
Path=${execPath.endsWith('-Setup.AppImage') ? path.resolve(appDirpath, '..') : path.resolve(appDirpath)}
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
  // Window controls
  ipcMain.handle('app:close', () => {
    mainWindow?.close();
  });
  ipcMain.handle('app:minimize', () => {
    mainWindow?.minimize();
  });

  // Utilities
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

  // Addon helpers
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

  ipcMain.handle('app:get-local-image', async (_, requestPath: string) => {
    if (!fs.existsSync(requestPath)) {
      return null;
    }

    // Validate path against allowed directories
    const allowedDirs = [
      join(__dirname, 'addons'),
      join(__dirname, 'public'),
      join(__dirname, 'config'),
    ];

    let realPath: string;
    try {
      realPath = fs.realpathSync(requestPath);
    } catch (err) {
      console.error('Failed to resolve real path:', path, err);
      return null;
    }

    // Normalize paths for comparison
    const normalizedRealPath = realPath.replace(/\\/g, '/');
    const isAllowed = allowedDirs.some((allowedDir) => {
      const normalizedAllowed = allowedDir.replace(/\\/g, '/');
      return normalizedRealPath.startsWith(normalizedAllowed);
    });

    if (!isAllowed) {
      console.error('Path not in allowed directories:', realPath);
      return null;
    }

    try {
      // Resolve to absolute path and normalize
      const ext = realPath.split('.').pop()?.toLowerCase() || 'png';

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
        const buffer = fs.readFileSync(realPath);
        const base64 = buffer.toString('base64');
        return `data:${mimeType};base64,${base64}`;
      } catch (err) {
        console.error('Failed to read image file: ' + realPath);
        return null;
      }
    } catch (err) {
      console.error('Error handling get-local-image request:', err);
      return null;
    }
  });

  // Desktop shortcut
  ipcMain.handle('app:add-to-desktop', async () => {
    return await addToDesktop();
  });

  // Register sub-handlers
  registerSteamHandlers();
  registerLibraryHandlers(mainWindow);
  registerRedistributableHandlers();
}
