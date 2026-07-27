const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { registerFixtureService } = require('../e2e/fixture-service.cjs');
const {
  validateApplicationRunDescriptor,
} = require('../e2e/src/application-run-descriptor.cjs');

const applicationDirectory = __dirname;
const runDescriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!runDescriptorPath) {
  throw new Error('OGI_RUN_DESCRIPTOR is required by the E2E harness');
}
const rawDescriptor = JSON.parse(fs.readFileSync(runDescriptorPath, 'utf8'));

let sandboxDirectory;
let userDataDirectory;
let artifactDirectory;
if (rawDescriptor.scenario === 'application-accessibility') {
  if (
    rawDescriptor.version !== 1 ||
    typeof rawDescriptor.sandboxDirectory !== 'string' ||
    !['welcome', 'oobe-resume', 'main'].includes(rawDescriptor.state)
  ) {
    throw new Error('Invalid accessibility Run Descriptor');
  }
  sandboxDirectory = rawDescriptor.sandboxDirectory;
} else {
  const descriptor = validateApplicationRunDescriptor(rawDescriptor);
  sandboxDirectory = descriptor.applicationStateDirectory;
  userDataDirectory = descriptor.userDataDirectory;
  artifactDirectory = descriptor.artifactDirectory;
  process.env.OGI_DIRECTORY = descriptor.applicationStateDirectory;
}

if (userDataDirectory) {
  fs.mkdirSync(userDataDirectory, { recursive: true });
  app.setPath('userData', userDataDirectory);
}

let mainLog;
let rendererLog;
if (artifactDirectory) {
  fs.mkdirSync(artifactDirectory, { recursive: true });
  mainLog = path.join(artifactDirectory, 'application-main.log');
  rendererLog = path.join(artifactDirectory, 'application-renderer.log');
  const appendMain = (level, values) => {
    fs.appendFileSync(
      mainLog,
      `${new Date().toISOString()} ${level} ${values
        .map((value) =>
          value instanceof Error ? value.stack || value.message : String(value)
        )
        .join(' ')}\n`
    );
  };
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      appendMain(level.toUpperCase(), values);
      original(...values);
    };
  }
  console.log(
    'Application E2E fixture started',
    rawDescriptor.runId,
    rawDescriptor.mode
  );
}

registerFixtureService(ipcMain, sandboxDirectory);

const addonServer = new WebSocketServer({ port: 7654 });
addonServer.on('connection', (socket) => {
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (!message.id) return;

    const args =
      message.event === 'query-connected-addons'
        ? { addons: [] }
        : message.event === 'get-deferred-tasks'
          ? { tasks: [] }
          : {};
    socket.send(
      JSON.stringify({
        event: 'response',
        id: message.id,
        args,
      })
    );
  });
});

app
  .whenReady()
  .then(async () => {
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
    window.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription) => {
        console.error(
          `Renderer failed to load: ${errorCode} ${errorDescription}`
        );
      }
    );
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`Application preload failed: ${preloadPath}`, error);
    });
    if (rendererLog) {
      window.webContents.on('console-message', (details) => {
        fs.appendFileSync(
          rendererLog,
          `${new Date().toISOString()} ${details.level} ${details.message}\n`
        );
      });
    }

    await window.loadFile(
      path.join(applicationDirectory, 'out/renderer/index.html')
    );
    if (artifactDirectory) {
      await window.webContents.executeJavaScript(
        `console.info('Application E2E renderer ready: ${rawDescriptor.runId}')`
      );
    }
    if (rawDescriptor.scenario === 'application-accessibility') {
      await window.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = './axe.min.js';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Failed to load Axe'));
          document.head.appendChild(script);
        })
      `);
    }
  })
  .catch((error) => {
    console.error('Application E2E fixture failed to start', error);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  addonServer.close();
  app.quit();
});
