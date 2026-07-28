const { mkdirSync, readFileSync } = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const updaterDirectory = __dirname;
const sandboxDirectory = process.env.OGI_SCENARIO_SANDBOX;
const accessibilityState = process.env.OGI_UPDATER_ACCESSIBILITY_STATE;
const axeSourcePath = process.env.OGI_AXE_SOURCE;

if (!sandboxDirectory) {
  throw new Error('OGI_SCENARIO_SANDBOX is required');
}
if (!axeSourcePath) {
  throw new Error('OGI_AXE_SOURCE is required');
}
const axeSource = readFileSync(axeSourcePath, 'utf8');

const userDataDirectory = path.join(sandboxDirectory, 'user-data');
mkdirSync(userDataDirectory, { recursive: true });
app.setPath('userData', userDataDirectory);

ipcMain.handle('get-branches', () => ({
  ok: true,
  branches: ['main', 'accessibility-fixture'],
}));
ipcMain.handle('get-recent-commits', () => ({
  ok: true,
  commits: [
    {
      sha: '0123456789abcdef',
      shortSha: '0123456',
      message: 'Accessibility fixture commit',
      author: 'E2E Fixture',
      date: '2026-07-24T00:00:00.000Z',
    },
  ],
}));

app
  .whenReady()
  .then(async () => {
    const { updaterFailure, updaterProgress, updaterRecovery } = await import(
      './dist/status.js'
    );
    const window = new BrowserWindow({
      width: 800,
      height: 700,
      show: true,
      webPreferences: {
        preload: path.join(updaterDirectory, 'dist/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    window.webContents.on('console-message', (_event, details) => {
      console.log(`[updater-renderer:${details.level}] ${details.message}`);
    });
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`Updater preload failed: ${preloadPath}`, error);
    });

    ipcMain.on('choose-channel', () => {
      void (async () => {
        if (accessibilityState === 'progress') {
          for (const payload of [
            updaterProgress('Downloading Update', 25, 100, '2 MB of 8 MB'),
            updaterProgress('Downloading Update', 26, 100, '2.1 MB of 8 MB'),
            updaterProgress('Downloading Update', 27, 100, '2.2 MB of 8 MB'),
          ]) {
            window.webContents.send('updater-status', payload);
          }
          return;
        }
        if (accessibilityState === 'failure') {
          window.webContents.send(
            'updater-status',
            updaterFailure(
              'Action required',
              'The Verified Release is invalid.'
            )
          );
          return;
        }
        if (accessibilityState === 'recovery') {
          window.webContents.send(
            'updater-status',
            updaterFailure(
              'Action required',
              'The Verified Release is invalid.'
            )
          );
          await window.webContents.executeJavaScript(`
            new Promise((resolve, reject) => {
              const alertHeading = document.querySelector('[role="alert"] h1');
              if (document.activeElement === alertHeading) {
                resolve();
                return;
              }
              const timeout = setTimeout(
                () => reject(new Error('Failure alert heading did not receive focus')),
                5000
              );
              alertHeading.addEventListener(
                'focus',
                () => {
                  clearTimeout(timeout);
                  resolve();
                },
                { once: true }
              );
            })
          `);
          window.webContents.send(
            'updater-status',
            updaterRecovery(
              'Restoring Previous Installation',
              'Your last known-good installation is being restored.'
            )
          );
        }
      })().catch((error) => {
        console.error('Updater accessibility transition failed', error);
        app.exit(1);
      });
    });

    await window.loadFile(path.join(updaterDirectory, 'public/index.html'));
    const preloadReady = await window.webContents.executeJavaScript(
      "typeof window.ogiUpdater?.onShowChannelPicker === 'function'"
    );
    if (!preloadReady) {
      throw new Error('Production updater preload API is unavailable');
    }
    await window.webContents.executeJavaScript(axeSource);
    window.webContents.send('show-channel-picker');
  })
  .catch((error) => {
    console.error('Updater accessibility fixture failed to start', error);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  app.quit();
});
