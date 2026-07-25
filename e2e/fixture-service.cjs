const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');
const { WebSocketServer } = require('ws');

function registerFixtureService(
  ipcMain,
  applicationStateDirectory,
  fixtureBaseUrl,
  scenarioSandboxDirectory,
  clientSdkPort
) {
  const replayEvents = new Map();
  const tasks = new Map();
  const addonInfo = {
    id: 'ogi-e2e-fixture-addon',
    name: 'OGI E2E Fixture Addon',
    version: '1.0.0',
    author: 'OpenGameInstaller E2E',
    description:
      'Deterministic catalog and installation data for required E2E runs.',
    repository: '',
    storefronts: ['ogi-e2e'],
    eventsAvailable: [
      'configure',
      'catalog',
      'game-details',
      'search',
      'setup',
    ],
    configTemplate: {},
  };
  const game = {
    appID: 7001,
    storefront: 'ogi-e2e',
    name: 'Golden Journey Fixture',
    capsuleImage: `${fixtureBaseUrl}/images/golden-journey.svg`,
  };

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

  for (const channel of ['fs:get-files-in-dir']) {
    ipcMain.handle(channel, () => []);
  }

  ipcMain.handle('oobe:download-tools', (event) => {
    event.sender.send('oobe:log', 'Using sandboxed prerequisite state');
    return [true, false];
  });
  ipcMain.handle('oobe:set-steamgriddb-key', () => true);
  ipcMain.handle('app:get-os', () => process.platform);
  ipcMain.handle('app:is-steam-deck', () => false);
  ipcMain.handle('app:is-online', () => true);
  ipcMain.handle('app:axios', () => ({ data: [] }));
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
    path.join(scenarioSandboxDirectory, 'installation/app/e2e-fixture-addon')
  );
  ipcMain.handle('app:get-all-apps', () => {
    const libraryDirectory = sandboxPath('./library');
    if (!fs.existsSync(libraryDirectory)) return [];
    return fs
      .readdirSync(libraryDirectory)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(libraryDirectory, name), 'utf8'))
      );
  });
  ipcMain.handle('app:get-library-info', (_event, appID) => {
    const libraryPath = sandboxPath(`./library/${appID}.json`);
    return fs.existsSync(libraryPath)
      ? JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
      : undefined;
  });
  ipcMain.handle('app:insert-app', (_event, libraryInfo) => {
    const libraryPath = sandboxPath(`./library/${libraryInfo.appID}.json`);
    fs.mkdirSync(path.dirname(libraryPath), { recursive: true });
    fs.writeFileSync(libraryPath, JSON.stringify(libraryInfo, null, 2));
    return 'success';
  });
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
      fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
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

  const websocketServer = new WebSocketServer({
    host: '127.0.0.1',
    port: clientSdkPort,
  });
  websocketServer.on('connection', (socket) => {
    socket.on('message', (rawMessage) => {
      const message = JSON.parse(rawMessage.toString());
      const respond = (args, statusError) =>
        socket.send(
          JSON.stringify({
            event: 'response',
            id: message.id,
            args,
            ...(statusError ? { statusError } : {}),
          })
        );
      if (message.event === 'query-connected-addons') {
        respond({ addons: [addonInfo] });
        return;
      }
      if (message.event === 'forward') {
        socket.send(
          JSON.stringify({
            event: 'forward-response',
            id: message.id,
            args: {
              addonId: message.args.addonId,
              event: message.args.event,
              args:
                message.args.event === 'config-update'
                  ? { success: true }
                  : undefined,
            },
          })
        );
        return;
      }
      if (message.event === 'defer-forward') {
        const taskID = randomUUID();
        const forwardedEvent = message.args.event;
        let data;
        if (forwardedEvent === 'catalog') {
          data = {
            sections: {
              goldenJourney: {
                name: 'Golden Journey',
                description:
                  'Deterministic games served by the Fixture Service',
                listings: [game],
              },
            },
          };
        } else if (forwardedEvent === 'game-details') {
          data = {
            ...game,
            basicDescription: 'A tiny deterministic game payload.',
            description: 'Used only by the packaged Golden Journey.',
            coverImage: game.capsuleImage,
            headerImage: game.capsuleImage,
            developers: ['OpenGameInstaller E2E'],
            publishers: ['OpenGameInstaller E2E'],
            releaseDate: '2026-01-01',
            latestVersion: '1.0.0',
          };
        } else if (forwardedEvent === 'search') {
          data = [
            {
              name: 'Fixture Service direct download',
              downloadType: 'direct',
              files: [
                {
                  name: 'golden-journey.txt',
                  downloadURL: `${fixtureBaseUrl}/games/golden-journey.txt`,
                },
              ],
              manifest: {
                fixture: 'golden-journey',
                prerequisites: 'sandboxed',
              },
            },
          ];
        } else if (forwardedEvent === 'setup') {
          const setup = message.args.args[0];
          data = {
            cwd: setup.path,
            launchExecutable: 'golden-journey.txt',
            version: '1.0.0',
          };
        }
        tasks.set(taskID, {
          id: taskID,
          addonOwner: addonInfo.id,
          finished: true,
          progress: 100,
          logs: ['Fixture Addon completed deterministically'],
          resolved: true,
          data,
        });
        respond({ taskID });
        return;
      }
      if (message.event === 'get-deferred-task') {
        respond({ task: tasks.get(message.args.taskID) });
        return;
      }
      if (message.event === 'get-deferred-tasks') {
        respond({ tasks: [...tasks.values()] });
      }
    });
  });

  return () => new Promise((resolve) => websocketServer.close(() => resolve()));
}

module.exports = { registerFixtureService };
