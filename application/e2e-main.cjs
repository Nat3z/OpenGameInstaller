const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { registerFixtureService } = require('../e2e/fixture-service.cjs');

const applicationDirectory = __dirname;
const runDescriptorPath = process.env.OGI_RUN_DESCRIPTOR;

if (!runDescriptorPath) {
  throw new Error('OGI_RUN_DESCRIPTOR is required by the accessibility harness');
}

const runDescriptor = JSON.parse(fs.readFileSync(runDescriptorPath, 'utf8'));
if (
  runDescriptor.version !== 1 ||
  runDescriptor.scenario !== 'application-accessibility' ||
  typeof runDescriptor.sandboxDirectory !== 'string' ||
  !['welcome', 'oobe-resume', 'main'].includes(runDescriptor.state)
) {
  throw new Error('Invalid accessibility Run Descriptor');
}

registerFixtureService(ipcMain, runDescriptor.sandboxDirectory);

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
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription) => {
      console.error(`Renderer failed to load: ${errorCode} ${errorDescription}`);
    }
  );

  await window.loadFile(
    path.join(applicationDirectory, 'out/renderer/index.html')
  );
  await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './axe.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load Axe'));
      document.head.appendChild(script);
    })
  `);
});

app.on('window-all-closed', () => {
  app.quit();
});
