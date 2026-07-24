const fs = require('node:fs');
const path = require('node:path');

function registerFixtureService(ipcMain, sandboxDirectory) {
  function sandboxPath(relativePath) {
    const resolved = path.resolve(sandboxDirectory, relativePath);
    const relative = path.relative(sandboxDirectory, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path escapes the scenario sandbox: ${relativePath}`);
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

  for (const channel of [
    'app:get-all-apps',
    'download:consume-replay-events',
    'download:get-handshake-state',
    'fs:get-files-in-dir',
  ]) {
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
}

module.exports = { registerFixtureService };
