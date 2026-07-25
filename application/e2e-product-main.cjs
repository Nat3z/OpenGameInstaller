const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { registerFixtureService } = require('../support/fixture-service.cjs');
const {
  validatePackagedHandoffRunDescriptor,
} = require('../support/packaged-handoff-run-descriptor.cjs');

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) {
  throw new Error('OGI_RUN_DESCRIPTOR is required by the Product Journey');
}
const descriptor = validatePackagedHandoffRunDescriptor(
  JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
);
const applicationDirectory = __dirname;
const mainLogPath = path.join(
  descriptor.artifactDirectory,
  'packaged-application-main.log'
);
const rendererLogPath = path.join(
  descriptor.artifactDirectory,
  'packaged-application-renderer.log'
);

fs.mkdirSync(descriptor.artifactDirectory, { recursive: true });
fs.mkdirSync(descriptor.applicationUserDataDirectory, { recursive: true });
app.setPath('userData', descriptor.applicationUserDataDirectory);
process.env.OGI_DIRECTORY = descriptor.applicationStateDirectory;

function logMain(message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  fs.appendFileSync(mainLogPath, `${message}${suffix}\n`);
  console.log(message, details ?? '');
}

process.env.OGI_FIXTURE_BASE_URL = descriptor.fixtureBaseUrl;
const closeFixtureIntegration = registerFixtureService(
  ipcMain,
  descriptor.applicationStateDirectory,
  descriptor.fixtureBaseUrl,
  descriptor.sandboxDirectory,
  descriptor.clientSdkPort
);

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width: 1000,
      height: 700,
      show: true,
      title: 'OpenGameInstaller',
      webPreferences: {
        preload: path.join(applicationDirectory, 'out/preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: true,
      },
    });
    window.webContents.on('console-message', (details) => {
      fs.appendFileSync(
        rendererLogPath,
        `[application-renderer:${details.level}] ${details.message}\n`
      );
    });
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      logMain('Packaged application preload failed', {
        preloadPath,
        error: error.message,
      });
    });
    await window.loadFile(
      path.join(applicationDirectory, 'out/renderer/index.html')
    );
    await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 30000;
        const check = () => {
          const interactiveSurface =
            document.querySelector('[aria-label="Library"]') ??
            [...document.querySelectorAll('h1')].find(
              (heading) => heading.textContent?.trim() === 'Welcome to OpenGameInstaller'
            );
          if (document.title === 'OpenGameInstaller' && interactiveSurface) {
            resolve(true);
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error('interactive application UI did not become ready'));
            return;
          }
          setTimeout(check, 50);
        };
        check();
      })
    `);
    const health = {
      version: 1,
      runId: descriptor.runId,
      state: 'interactive',
      surface: 'main',
      lastKnownGoodPresent: fs.existsSync(descriptor.backupDirectory),
      pid: process.pid,
    };
    if (!health.lastKnownGoodPresent) {
      throw new Error(
        'Last Known-Good Installation was removed before Startup Health'
      );
    }
    fs.writeFileSync(
      descriptor.startupHealthPath,
      JSON.stringify(health, null, 2)
    );
    fs.appendFileSync(
      descriptor.handoffLogPath,
      `${JSON.stringify({ phase: 'startup-health', ...health })}\n`
    );
    logMain('Startup Health emitted after interactive UI', health);
  })
  .catch((error) => {
    logMain('Packaged application failed to start', {
      error: error instanceof Error ? error.message : String(error),
    });
    app.exit(1);
  });

app.on('window-all-closed', () => {
  void closeFixtureIntegration().finally(() => app.quit());
});
