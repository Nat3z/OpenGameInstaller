const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const applicationDirectory = __dirname;
const sandboxDirectory = process.env.OGI_DIRECTORY;

if (!sandboxDirectory) {
  throw new Error('OGI_DIRECTORY is required by the accessibility harness');
}

function sandboxPath(relativePath) {
  const resolved = path.resolve(sandboxDirectory, relativePath);
  const relative = path.relative(sandboxDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the accessibility sandbox: ${relativePath}`);
  }
  return resolved;
}

ipcMain.on('get-initial-theme', (event) => {
  event.returnValue = 'light';
});
ipcMain.on('get-version', (event) => {
  event.returnValue = '4.1.0';
});
ipcMain.on('is-dev', (event) => {
  event.returnValue = false;
});
ipcMain.on('fs:exists', (event, relativePath) => {
  event.returnValue = fs.existsSync(sandboxPath(relativePath));
});
ipcMain.on('fs:read', (event, relativePath) => {
  event.returnValue = fs.readFileSync(sandboxPath(relativePath), 'utf8');
});
ipcMain.on('fs:mkdir', (event, relativePath) => {
  fs.mkdirSync(sandboxPath(relativePath), { recursive: true });
  event.returnValue = true;
});
ipcMain.on('fs:write', (event, { path: relativePath, data }) => {
  const destination = sandboxPath(relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, data);
  event.returnValue = true;
});
ipcMain.on('fs:delete:sync', (event, relativePath) => {
  fs.rmSync(sandboxPath(relativePath), { recursive: true, force: true });
  event.returnValue = true;
});

const emptyArrayChannels = [
  'app:get-all-apps',
  'download:consume-replay-events',
  'download:get-handshake-state',
  'fs:get-files-in-dir',
];
for (const channel of emptyArrayChannels) {
  ipcMain.handle(channel, () => []);
}

ipcMain.handle('app:get-os', () => process.platform);
ipcMain.handle('app:is-steam-deck', () => false);
ipcMain.handle('app:is-online', () => true);
ipcMain.handle('app:axios', () => ({ data: [] }));
ipcMain.handle('install-addons', () => true);
ipcMain.handle('update-addons', () => true);
ipcMain.handle('clean-addons', () => true);
ipcMain.handle('restart-addon-server', () => true);
ipcMain.handle('power-save:set-active', () => true);
ipcMain.handle('app:add-to-desktop', () => ({ success: true }));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: {
      preload: path.join(applicationDirectory, 'out/preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: true,
    },
  });
  window.webContents.on('console-message', (_event, details) => {
    console.log(`[renderer:${details.level}] ${details.message}`);
  });
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription) => {
      console.error(`Renderer failed to load: ${errorCode} ${errorDescription}`);
    }
  );

  await window.loadFile(
    path.join(applicationDirectory, 'out/renderer/index.html')
  );
});

app.on('window-all-closed', () => {
  app.quit();
});
