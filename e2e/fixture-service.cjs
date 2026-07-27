const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function registerFixtureService(
  ipcMain,
  applicationStateDirectory,
  fixtureBaseUrl,
  scenarioSandboxDirectory,
  clientSdkPort,
  effectiveOnline = true,
  torrentFixture = null
) {
  fixtureBaseUrl ??= 'http://127.0.0.1:1';
  scenarioSandboxDirectory ??= applicationStateDirectory;
  const replayEvents = new Map();
  let torrentRuntime;
  let torrentReady = Promise.resolve();
  const fixtureAddonDirectory = path.join(
    scenarioSandboxDirectory,
    'installation/app/ogi-e2e-fixture-addon'
  );
  const libraryRuntime =
    clientSdkPort === undefined
      ? {
          ensureLibraryDir: () =>
            fs.mkdirSync(sandboxPath('./library'), { recursive: true }),
          getAllLibraryFiles: () => {
            const libraryDirectory = sandboxPath('./library');
            if (!fs.existsSync(libraryDirectory)) return [];
            return fs
              .readdirSync(libraryDirectory)
              .filter((name) => name.endsWith('.json'))
              .map((name) =>
                JSON.parse(
                  fs.readFileSync(path.join(libraryDirectory, name), 'utf8')
                )
              );
          },
          loadLibraryInfo: (appID) => {
            const libraryPath = sandboxPath(`./library/${appID}.json`);
            return fs.existsSync(libraryPath)
              ? JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
              : null;
          },
          saveLibraryInfo: (appID, libraryInfo) =>
            fs.writeFileSync(
              sandboxPath(`./library/${appID}.json`),
              JSON.stringify(libraryInfo, null, 2)
            ),
          removeLibraryFile: (appID) =>
            fs.rmSync(sandboxPath(`./library/${appID}.json`), { force: true }),
          removeFromInternalsApps: (appID) => {
            const appsPath = sandboxPath('./internals/apps.json');
            if (!fs.existsSync(appsPath)) return;
            const apps = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
            fs.writeFileSync(
              appsPath,
              JSON.stringify(
                apps.filter((id) => id !== appID),
                null,
                2
              )
            );
          },
          uninstallGameFromLibrary: (appID, deleteFiles) => {
            if (deleteFiles) {
              throw new Error(
                'File deletion requires the packaged production library runtime'
              );
            }
            fs.rmSync(sandboxPath(`./library/${appID}.json`), { force: true });
            return { filesRemoved: false };
          },
        }
      : require(path.join(fixtureAddonDirectory, 'dist/library-runtime.cjs'));
  const {
    ensureLibraryDir,
    getAllLibraryFiles,
    loadLibraryInfo,
    removeFromInternalsApps,
    removeLibraryFile,
    saveLibraryInfo,
    uninstallGameFromLibrary,
  } = libraryRuntime;

  function sandboxPath(relativePath) {
    const resolved = path.isAbsolute(relativePath)
      ? path.resolve(relativePath)
      : path.resolve(applicationStateDirectory, relativePath);
    const relative = path.relative(scenarioSandboxDirectory, resolved);
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
    const source = sandboxPath(relativePath);
    event.returnValue = fs.existsSync(source)
      ? fs.readFileSync(source, 'utf8')
      : null;
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

  ipcMain.handle('fs:get-files-in-dir', (_event, relativePath) => {
    const directory = sandboxPath(relativePath);
    return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  });
  ipcMain.handle('fs:delete', async (_event, relativePath) => {
    fs.rmSync(sandboxPath(relativePath), { recursive: true, force: true });
    return true;
  });
  ipcMain.handle('fs:move', async (_event, { source, destination }) => {
    const sourcePath = sandboxPath(source);
    const destinationPath = sandboxPath(destination);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.renameSync(sourcePath, destinationPath);
    return 'success';
  });
  ipcMain.on('fs:stat', (event, { path: relativePath }) => {
    const target = sandboxPath(relativePath);
    event.returnValue = fs.existsSync(target)
      ? {
          size: fs.statSync(target).size,
          isDirectory: fs.statSync(target).isDirectory(),
        }
      : null;
  });

  ipcMain.handle('oobe:download-tools', (event) => {
    event.sender.send('oobe:log', 'Using sandboxed prerequisite state');
    return [true, false];
  });
  ipcMain.handle('oobe:set-steamgriddb-key', () => true);
  ipcMain.handle('app:get-os', () => process.platform);
  ipcMain.handle('app:is-steam-deck', () => false);
  ipcMain.handle('app:is-online', () => effectiveOnline);
  ipcMain.handle('app:axios', () => ({
    data: [
      {
        name: 'Steam Integration',
        author: 'OpenGameInstaller E2E',
        source: 'https://github.com/Nat3z/steam-integration',
        img: `${fixtureBaseUrl}/images/golden-journey.svg`,
        description: 'Deterministic representation of the default selection',
      },
    ],
  }));
  let addonRuntime;
  if (clientSdkPort === undefined || !effectiveOnline) {
    ipcMain.handle('install-addons', (_event, addons) => {
      const generalPath = sandboxPath('./config/option/general.json');
      const general = JSON.parse(fs.readFileSync(generalPath, 'utf8'));
      fs.writeFileSync(
        generalPath,
        JSON.stringify({ ...general, addons: [...new Set(addons)] })
      );
      return true;
    });
    ipcMain.handle('update-addons', () => true);
    ipcMain.handle('clean-addons', () => true);
    ipcMain.handle('restart-addon-server', () => true);
  } else {
    addonRuntime = require(
      path.join(fixtureAddonDirectory, 'dist/addon-runtime.cjs')
    );
    addonRuntime.default();
  }
  ipcMain.handle('power-save:set-active', () => true);
  ipcMain.handle('app:add-to-desktop', () => ({ success: true }));
  ipcMain.handle(
    'app:get-addon-icon',
    () => `${fixtureBaseUrl}/images/golden-journey.svg`
  );
  ipcMain.handle(
    'app:get-local-image',
    () => `${fixtureBaseUrl}/images/golden-journey.svg`
  );
  ipcMain.handle('app:get-addon-path', () =>
    path.join(
      scenarioSandboxDirectory,
      'installation/app/ogi-e2e-fixture-addon'
    )
  );
  ipcMain.handle('app:get-all-apps', () => getAllLibraryFiles());
  ipcMain.handle(
    'app:get-library-info',
    (_event, appID) => loadLibraryInfo(appID) ?? undefined
  );
  ipcMain.handle('app:insert-app', (_event, libraryInfo) => {
    ensureLibraryDir();
    saveLibraryInfo(libraryInfo.appID, libraryInfo);
    return 'success';
  });
  ipcMain.handle('app:launch-game', (event, appID) => {
    const libraryInfo = loadLibraryInfo(Number(appID));
    if (!libraryInfo) throw new Error(`Fixture game not found: ${appID}`);
    const gameEnvironment = { ...process.env };
    delete gameEnvironment.ELECTRON_RUN_AS_NODE;
    if (!gameEnvironment.OGI_OFFLINE_TRAFFIC_GUARD_CONFIG) {
      delete gameEnvironment.NODE_OPTIONS;
    }
    const gameLogPath = path.join(
      scenarioSandboxDirectory,
      'artifacts',
      'fixture-game.log'
    );
    const gameLog = fs.openSync(gameLogPath, 'a');
    const child = spawn(libraryInfo.launchExecutable, [], {
      cwd: libraryInfo.cwd,
      env: gameEnvironment,
      shell:
        process.platform === 'win32' &&
        /\.(bat|cmd)$/i.test(libraryInfo.launchExecutable),
      stdio: ['ignore', gameLog, gameLog],
    });
    event.sender.send('game:launch', { id: libraryInfo.appID });
    child.once('error', (error) => {
      fs.appendFileSync(gameLogPath, `Fixture game spawn failed: ${error}\n`);
      fs.closeSync(gameLog);
      event.sender.send('game:exit', { id: libraryInfo.appID });
    });
    child.once('exit', (code, signal) => {
      fs.appendFileSync(
        gameLogPath,
        `Fixture game exited with code ${code} and signal ${signal}\n`
      );
      fs.closeSync(gameLog);
      event.sender.send('game:exit', { id: libraryInfo.appID });
    });
  });
  ipcMain.handle('app:remove-app', (_event, appID, options) =>
    uninstallGameFromLibrary(Number(appID), options?.deleteFiles === true)
  );
  if (clientSdkPort === undefined || !effectiveOnline) {
    ipcMain.handle('ddl:download', async (_event, downloads) => {
      const id = randomUUID();
      for (const download of downloads) {
        const response = await fetch(download.link, {
          headers: download.headers,
        });
        if (!response.ok) {
          return {
            id,
            status: 'error',
            error: `Fixture download failed: ${response.status}`,
          };
        }
        const destination = sandboxPath(download.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(
          destination,
          Buffer.from(await response.arrayBuffer())
        );
      }
      replayEvents.set(id, [
        {
          channel: 'ddl:download-progress',
          data: {
            id,
            progress: 1,
            downloadSpeed: 1,
            fileSize: fs.statSync(sandboxPath(downloads[0].path)).size,
            status: 'completed',
          },
        },
        { channel: 'ddl:download-complete', data: { id } },
      ]);
      return { id, status: 'completed' };
    });
    ipcMain.handle('download:consume-replay-events', (_event, id) => {
      const events = replayEvents.get(id) ?? [];
      replayEvents.delete(id);
      return events;
    });
    ipcMain.handle('download:get-handshake-state', (_event, id) =>
      replayEvents.has(id) ? { id, status: 'completed' } : undefined
    );
  } else {
    const directDownloadRuntime = require(
      path.join(fixtureAddonDirectory, 'dist/download-runtime.cjs')
    );
    directDownloadRuntime.registerDownloadHandshakeHandlers();
    directDownloadRuntime.default();
    if (torrentFixture) {
      torrentReady = import(
        pathToFileURL(
          path.join(fixtureAddonDirectory, 'dist/torrent-runtime.mjs')
        ).href
      ).then((runtime) => {
        torrentRuntime = runtime;
        torrentRuntime.configureWebTorrentClient({
          dht: false,
          lsd: false,
          utp: false,
          tracker: true,
          natUpnp: false,
          natPmp: false,
        });
        torrentRuntime.default();
      });
    }
  }

  if (clientSdkPort === undefined || !effectiveOnline) {
    const close = async () => {};
    close.ready = Promise.resolve();
    return close;
  }

  const installedStatePath = path.join(
    applicationStateDirectory,
    'config/option/installed.json'
  );
  const ready = Promise.all([
    addonRuntime.startAddonServer(),
    torrentReady,
  ]).then(() => undefined);
  let restoredAddonsReady;
  ipcMain.on('client-ready-for-events', (event) => {
    if (!fs.existsSync(installedStatePath)) return;
    restoredAddonsReady ??= ready.then(() =>
      addonRuntime.startAddonsForFixture()
    );
    void restoredAddonsReady.then(() => {
      if (event.sender.isDestroyed()) return;
      event.sender.send('addon-runtime-ready');
      setTimeout(() => {
        if (event.sender.isDestroyed()) return;
        event.sender.send('addon-connected', 'ogi-e2e-fixture-addon');
      }, 1000);
    });
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await torrentReady;
    await torrentRuntime?.stopWebTorrentClient();
    await addonRuntime.stopAddonServer();
  };
  close.ready = ready;
  return close;
}

module.exports = { registerFixtureService };
