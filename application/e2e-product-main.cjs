const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { registerFixtureService } = require('../support/fixture-service.cjs');
const {
  descendantGuardEnvironment,
  installOfflineTrafficGuard,
} = require('../support/offline-traffic-guard.cjs');
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
const recovery = process.env.OGI_RECOVERY_STARTUP_HEALTH === 'true';
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
process.env.OGI_FIXTURE_ELECTRON_PATH = process.execPath;
process.env.OGI_FIXTURE_GAME_MARKER_PATH = path.join(
  descriptor.fixtureStateDirectory,
  'fixture-game-launch.json'
);
process.env.OGI_FIXTURE_GAME_AUTOMATION_PORT = String(
  descriptor.gameAutomationPort
);
if (descriptor.deterministicTorrentInstallation) {
  process.env.OGI_FIXTURE_TORRENT_URL = descriptor.torrentUrl;
} else {
  delete process.env.OGI_FIXTURE_TORRENT_URL;
}
let closeFixtureIntegration = async () => {};
closeFixtureIntegration.ready = Promise.resolve();

app
  .whenReady()
  .then(async () => {
    const { getRequestedOnlineState, resolveEffectiveOnlineState } =
      await import('../support/application-online-state.mjs');
    const onlineState = resolveEffectiveOnlineState(
      getRequestedOnlineState(process.argv),
      true
    );
    if (descriptor.offlineProductBehavior && onlineState.effectiveOnline) {
      throw new Error(
        'Production application online-state logic did not select offline'
      );
    }
    if (
      descriptor.offlineProductBehavior ||
      descriptor.incrementalUpdate !== 'none' ||
      descriptor.deterministicTorrentInstallation
    ) {
      const trafficLogPath = path.join(
        descriptor.artifactDirectory,
        'packaged-application-traffic.jsonl'
      );
      const expectedEndpoints = [
        { host: '127.0.0.1', port: descriptor.clientSdkPort },
        { host: 'localhost', port: descriptor.clientSdkPort },
        ...(descriptor.incrementalUpdate === 'none' &&
        !descriptor.deterministicTorrentInstallation
          ? []
          : [
              {
                host: '127.0.0.1',
                port: Number(new URL(descriptor.fixtureBaseUrl).port),
              },
            ]),
        ...(descriptor.deterministicTorrentInstallation
          ? [
              {
                host: '127.0.0.1',
                port: Number(new URL(descriptor.torrentTrackerUrl).port),
              },
              {
                host: '127.0.0.1',
                port: descriptor.torrentPeerPort,
              },
            ]
          : []),
      ];
      Object.assign(
        process.env,
        descendantGuardEnvironment({
          logPath: trafficLogPath,
          product: 'application-descendant',
          expectedEndpoints,
          recordListeners: descriptor.deterministicTorrentInstallation,
        })
      );
      installOfflineTrafficGuard({
        session: session.defaultSession,
        logPath: trafficLogPath,
        product: 'application',
        expectedEndpoints,
        recordListeners: descriptor.deterministicTorrentInstallation,
      });
    }
    closeFixtureIntegration = registerFixtureService(
      ipcMain,
      descriptor.applicationStateDirectory,
      descriptor.fixtureBaseUrl,
      descriptor.sandboxDirectory,
      descriptor.clientSdkPort,
      onlineState.effectiveOnline,
      descriptor.deterministicTorrentInstallation
        ? {
            torrentUrl: descriptor.torrentUrl,
            trackerUrl: descriptor.torrentTrackerUrl,
            peerPort: descriptor.torrentPeerPort,
          }
        : null
    );
    await closeFixtureIntegration.ready;
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
    if (descriptor.offlineProductBehavior) {
      const offlineReady = {
        phase: 'offline-application-interactive',
        runId: descriptor.runId,
        state: 'interactive',
        pid: process.pid,
        online: onlineState.effectiveOnline,
        reason: onlineState.reason,
        productionDecision: true,
      };
      fs.appendFileSync(
        descriptor.handoffLogPath,
        `${JSON.stringify(offlineReady)}\n`
      );
      logMain('Offline application is interactive', offlineReady);
      return;
    }
    if (fs.existsSync(descriptor.startupHealthPath)) {
      const relaunch = {
        phase: 'application-relaunched',
        runId: descriptor.runId,
        state: 'interactive',
        pid: process.pid,
      };
      fs.appendFileSync(
        descriptor.handoffLogPath,
        `${JSON.stringify(relaunch)}\n`
      );
      logMain('Packaged application relaunched with interactive UI', relaunch);
      return;
    }
    if (!recovery && descriptor.recoveryFailure === 'crash') {
      throw new Error('Candidate application crashed before Startup Health');
    }
    if (
      !recovery &&
      ['immediate-root-exit', 'fork-during-scan', 'timeout'].includes(
        descriptor.recoveryFailure
      )
    ) {
      const descendantScript =
        descriptor.recoveryFailure === 'fork-during-scan'
          ? `const {spawn}=require('node:child_process');let spawned=0;const timer=setInterval(()=>{const child=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:['ignore','ignore','ignore',3]});child.unref();spawned+=1;if(spawned>=16)clearInterval(timer)},20);setInterval(()=>{},1000)`
          : 'setInterval(() => {}, 1000)';
      const detachedDescendant = spawn(
        descriptor.recoveryFailure === 'fork-during-scan'
          ? 'node'
          : process.execPath,
        ['-e', descendantScript],
        {
          detached: true,
          env: process.env,
          stdio: ['ignore', 'ignore', 'ignore', 3],
        }
      );
      detachedDescendant.unref();
      fs.appendFileSync(
        descriptor.handoffLogPath,
        `${JSON.stringify({
          phase: 'detached-candidate-descendant-launched',
          pid: detachedDescendant.pid,
        })}\n`
      );
      logMain('Candidate intentionally withheld Startup Health', {
        recoveryFailure: descriptor.recoveryFailure,
        detachedDescendantPid: detachedDescendant.pid,
      });
      if (descriptor.recoveryFailure === 'immediate-root-exit') {
        setTimeout(() => app.exit(17), 25);
      }
      return;
    }
    const health = {
      version: 1,
      runId:
        descriptor.recoveryFailure === 'invalid-health' && !recovery
          ? `${descriptor.runId}-invalid`
          : descriptor.runId,
      state: 'interactive',
      surface: 'main',
      lastKnownGoodPresent: fs.existsSync(descriptor.backupDirectory),
      recovery,
      pid: process.pid,
      processAlive: true,
      transactionToken: process.env.OGI_UPDATE_TRANSACTION_TOKEN,
    };
    if (!recovery && !health.lastKnownGoodPresent) {
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
    void closeFixtureIntegration().finally(() => app.exit(1));
  });

app.on('window-all-closed', () => {
  void closeFixtureIntegration().finally(() => app.quit());
});
