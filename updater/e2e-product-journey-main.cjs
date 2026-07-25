const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const {
  validatePackagedHandoffRunDescriptor,
} = require('./support/packaged-handoff-run-descriptor.cjs');

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) {
  throw new Error('OGI_RUN_DESCRIPTOR is required by the Product Journey');
}
const descriptor = validatePackagedHandoffRunDescriptor(
  JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
);
const updaterDirectory = __dirname;
const mainLogPath = path.join(
  descriptor.artifactDirectory,
  'packaged-updater-main.log'
);
const rendererLogPath = path.join(
  descriptor.artifactDirectory,
  'packaged-updater-renderer.log'
);
fs.mkdirSync(descriptor.artifactDirectory, { recursive: true });
fs.mkdirSync(descriptor.updaterUserDataDirectory, { recursive: true });
app.setPath('userData', descriptor.updaterUserDataDirectory);

function appendHandoff(value) {
  fs.appendFileSync(descriptor.handoffLogPath, `${JSON.stringify(value)}\n`);
}

function logMain(message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  fs.appendFileSync(mainLogPath, `${message}${suffix}\n`);
  console.log(message, details ?? '');
}

function containedPath(root, candidate) {
  const destination = path.resolve(root, candidate);
  const fromRoot = path.relative(path.resolve(root), destination);
  if (
    fromRoot === '' ||
    fromRoot.startsWith('..') ||
    path.isAbsolute(fromRoot)
  ) {
    throw new Error(`Candidate path is unsafe: ${candidate}`);
  }
  return destination;
}

function materializeArtifact(artifact) {
  if (
    artifact.formatVersion !== 1 ||
    artifact.platform !== descriptor.platform ||
    artifact.version !== 'v4.1.0-e2e' ||
    artifact.entryPoint !== 'app/e2e-product-main.cjs' ||
    !Array.isArray(artifact.files)
  ) {
    throw new Error('Packaged application artifact is invalid');
  }
  fs.rmSync(descriptor.stagingDirectory, { recursive: true, force: true });
  fs.mkdirSync(descriptor.stagingDirectory, { recursive: true });
  for (const file of artifact.files) {
    const destination = containedPath(descriptor.stagingDirectory, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(file.contents, 'base64'));
    fs.chmodSync(destination, file.mode);
  }
  fs.writeFileSync(
    path.join(descriptor.stagingDirectory, 'version.txt'),
    artifact.version
  );
  return artifact.entryPoint;
}

async function waitForStartupHealth() {
  const deadline = Date.now() + descriptor.healthTimeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(descriptor.startupHealthPath)) {
      const health = JSON.parse(
        fs.readFileSync(descriptor.startupHealthPath, 'utf8')
      );
      if (
        health.version === 1 &&
        health.runId === descriptor.runId &&
        health.state === 'interactive' &&
        health.lastKnownGoodPresent === true
      ) {
        return health;
      }
      throw new Error('Startup Health Signal is invalid');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Startup Health Signal did not arrive before the deadline');
}

async function downloadAndLaunch() {
  appendHandoff({ phase: 'release-requested', url: descriptor.releaseApiUrl });
  const releasesResponse = await fetch(descriptor.releaseApiUrl);
  if (!releasesResponse.ok) {
    throw new Error(
      `Fixture release request failed: ${releasesResponse.status}`
    );
  }
  const releases = await releasesResponse.json();
  const release = Array.isArray(releases) ? releases[0] : undefined;
  const asset = release?.assets?.[0];
  if (
    release?.tag_name !== 'v4.1.0-e2e' ||
    asset?.browser_download_url !== descriptor.artifactUrl
  ) {
    throw new Error('Fixture release metadata is invalid');
  }
  appendHandoff({ phase: 'artifact-requested', url: descriptor.artifactUrl });
  const artifactResponse = await fetch(descriptor.artifactUrl);
  if (!artifactResponse.ok) {
    throw new Error(
      `Fixture artifact request failed: ${artifactResponse.status}`
    );
  }
  const artifact = await artifactResponse.json();
  const entryPointFromInstall = materializeArtifact(artifact);
  fs.rmSync(descriptor.backupDirectory, { recursive: true, force: true });
  fs.cpSync(descriptor.installationDirectory, descriptor.backupDirectory, {
    recursive: true,
  });
  appendHandoff({
    phase: 'last-known-good-retained',
    version: fs.readFileSync(
      path.join(descriptor.backupDirectory, 'version.txt'),
      'utf8'
    ),
  });
  fs.rmSync(descriptor.installationDirectory, {
    recursive: true,
    force: true,
  });
  fs.renameSync(descriptor.stagingDirectory, descriptor.installationDirectory);
  const entryPoint = path.join(
    descriptor.installationDirectory,
    entryPointFromInstall
  );
  const electronArgs = [
    `--remote-debugging-port=${descriptor.automationPort}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    entryPoint,
  ];
  const child = spawn(process.execPath, electronArgs, {
    cwd: descriptor.installationDirectory,
    env: {
      ...process.env,
      OGI_RUN_DESCRIPTOR: descriptorPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(fs.createWriteStream(mainLogPath, { flags: 'a' }));
  child.stderr.pipe(fs.createWriteStream(mainLogPath, { flags: 'a' }));
  child.once('error', (error) => {
    logMain('Updater-launched application failed', { error: error.message });
  });
  appendHandoff({
    phase: 'application-launched',
    pid: child.pid,
    descriptorPath,
    forwardedE2EKeys: Object.keys(process.env).filter((key) =>
      key.startsWith('OGI_')
    ),
    automationPort: descriptor.automationPort,
  });
  const health = await waitForStartupHealth();
  fs.rmSync(descriptor.backupDirectory, { recursive: true, force: true });
  appendHandoff({
    phase: 'last-known-good-released',
    health,
    backupPresent: fs.existsSync(descriptor.backupDirectory),
  });
  return health;
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
      fs.appendFileSync(
        rendererLogPath,
        `[updater-renderer:${details.level}] ${details.message}\n`
      );
    });
    ipcMain.on('choose-channel', (_event, choice) => {
      void (async () => {
        if (choice?.channel !== 'stable') {
          throw new Error('The Product Journey requires Stable');
        }
        window.webContents.send(
          'updater-status',
          updaterStatus('Installing Packaged Fixture Release')
        );
        const health = await downloadAndLaunch();
        window.webContents.send(
          'updater-status',
          updaterStatus(
            'Startup Health Confirmed',
            `${health.surface} UI is interactive`
          )
        );
      })().catch((error) => {
        logMain('Packaged handoff failed', { error: error.message });
        window.webContents.send(
          'updater-status',
          updaterFailure('Packaged Handoff Failed', error.message)
        );
      });
    });
    await window.loadFile(path.join(updaterDirectory, 'public/index.html'));
    window.webContents.send('show-channel-picker');
    logMain('Packaged updater renderer ready', { runId: descriptor.runId });
  })
  .catch((error) => {
    logMain('Packaged updater failed to start', { error: error.message });
    app.exit(1);
  });

app.on('window-all-closed', () => {
  app.quit();
});
