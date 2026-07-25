const {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const {
  validateUpdaterRunDescriptor,
} = require('../e2e/src/updater-run-descriptor.cjs');

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) {
  throw new Error('OGI_RUN_DESCRIPTOR is required by the Updater Scenario');
}
const descriptor = validateUpdaterRunDescriptor(
  JSON.parse(readFileSync(descriptorPath, 'utf8'))
);
const updaterDirectory = __dirname;
const mainLogPath = path.join(descriptor.artifactDirectory, 'updater-main.log');
const rendererLogPath = path.join(
  descriptor.artifactDirectory,
  'updater-renderer.log'
);
mkdirSync(descriptor.artifactDirectory, { recursive: true });
writeFileSync(mainLogPath, '');
writeFileSync(rendererLogPath, '');
app.setPath('userData', descriptor.userDataDirectory);

function logMain(message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  appendFileSync(mainLogPath, `${message}${suffix}\n`);
  console.log(message, details ?? '');
}

function resolveNativeDialog(action, options) {
  const queued = descriptor.nativeDialogResponses.find(
    (entry) => entry.action === action
  );
  if (!queued) {
    throw new Error(`No native-dialog response queued for ${action}`);
  }
  const request = {
    timestamp: new Date().toISOString(),
    action,
    kind: 'message-box',
    options,
    response: queued.response,
  };
  appendFileSync(
    descriptor.nativeDialogLogPath,
    `${JSON.stringify(request)}\n`
  );
  logMain('Resolved queued native dialog', request);
  return queued.response;
}

ipcMain.handle('get-branches', () => ({ ok: true, branches: ['main'] }));
ipcMain.handle('get-recent-commits', () => ({ ok: true, commits: [] }));

app
  .whenReady()
  .then(async () => {
    const { updaterFailure, updaterStatus } = await import('./dist/status.js');
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

    window.webContents.on('console-message', (details) => {
      appendFileSync(
        rendererLogPath,
        `[updater-renderer:${details.level}] ${details.message}\n`
      );
    });
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      logMain('Updater preload failed', {
        preloadPath,
        error: error.message,
      });
    });

    ipcMain.on('choose-channel', (_event, choice) => {
      void (async () => {
        logMain('Received visible channel selection', choice);
        if (choice?.channel !== 'stable') {
          window.webContents.send(
            'updater-status',
            updaterFailure(
              'Unsupported Fixture Channel',
              'The deterministic Updater Scenario requires Stable.'
            )
          );
          return;
        }
        const response = resolveNativeDialog('choose-stable-channel', {
          type: 'question',
          buttons: ['Check Fixture Release', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          title: 'Check for updates',
          message: 'Check the Stable channel for a fixture release?',
        });
        if (response !== 0) {
          window.webContents.send(
            'updater-status',
            updaterStatus('Update Check Cancelled')
          );
          return;
        }

        window.webContents.send(
          'updater-status',
          updaterStatus('Checking Fixture Release')
        );
        logMain('Requesting release metadata', {
          url: descriptor.releaseApiUrl,
        });
        const releaseResponse = await fetch(descriptor.releaseApiUrl);
        if (!releaseResponse.ok) {
          throw new Error(
            `Fixture release request failed with ${releaseResponse.status}`
          );
        }
        const releases = await releaseResponse.json();
        const release = Array.isArray(releases) ? releases[0] : undefined;
        if (!release || typeof release.tag_name !== 'string') {
          throw new Error('Fixture release response is invalid');
        }
        logMain('Received fixture release metadata', {
          tagName: release.tag_name,
        });
        window.webContents.send(
          'updater-status',
          updaterStatus(
            'Fixture Release Ready',
            `${release.tag_name} from Fixture Service`
          )
        );
      })().catch((error) => {
        logMain('Updater Scenario failed', { error: error.message });
        window.webContents.send(
          'updater-status',
          updaterFailure('Fixture Release Failed', error.message)
        );
      });
    });

    await window.loadFile(path.join(updaterDirectory, 'public/index.html'));
    const preloadReady = await window.webContents.executeJavaScript(
      "typeof window.ogiUpdater?.onShowChannelPicker === 'function'"
    );
    if (!preloadReady) {
      throw new Error('Production updater preload API is unavailable');
    }
    await window.webContents.executeJavaScript(
      `console.log(${JSON.stringify(`Updater Scenario renderer ready ${descriptor.runId}`)})`
    );
    logMain('Updater Scenario renderer ready', { runId: descriptor.runId });
    window.webContents.send('show-channel-picker');
  })
  .catch((error) => {
    logMain('Updater Scenario failed to start', { error: error.message });
    app.exit(1);
  });

app.on('window-all-closed', () => {
  app.quit();
});
