import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { Effect, Layer } from 'effect';
import {
  type SteamLocation,
  SteamRepository,
} from '../src/electron/lib/steam-installation.js';
import { SteamProcess } from '../src/electron/lib/steam-process.js';
import {
  generateNonSteamAppId,
  readShortcuts,
  upsertShortcut,
} from '../src/electron/lib/steam-shortcuts.js';
import {
  type BinaryVdfObject,
  serializeBinaryVdf,
  updateSteamCompatToolMapping,
} from '../src/electron/lib/steam-vdf.js';

const ogiDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ogi-steam-service-')
);
process.env.OGI_DIRECTORY = ogiDirectory;
mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => ogiDirectory },
}));

let SteamService: typeof import('../src/electron/handlers/helpers.app/steam.js').SteamService;
let SteamServiceLive: typeof import('../src/electron/handlers/helpers.app/steam.js').SteamServiceLive;

beforeAll(async () => {
  ({ SteamService, SteamServiceLive } = await import(
    '../src/electron/handlers/helpers.app/steam.js'
  ));
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(path.join(ogiDirectory, 'config'), {
    recursive: true,
    force: true,
  });
});

afterAll(() => {
  fs.rmSync(ogiDirectory, { recursive: true, force: true });
});

const libraryInfo = (appID: number): LibraryInfo => ({
  name: 'Example Game',
  version: String(appID),
  cwd: '/games/example',
  launchExecutable: '/games/example/game.exe',
  appID,
  capsuleImage: '',
  storefront: 'test',
  addonsource: 'test',
  coverImage: '',
});

const writeLibraryInfo = (appInfo: LibraryInfo): void => {
  fs.mkdirSync(path.join(ogiDirectory, 'library'), { recursive: true });
  fs.writeFileSync(
    path.join(ogiDirectory, `library/${appInfo.appID}.json`),
    JSON.stringify(appInfo)
  );
};

const writeCompatibilityTool = (value: string): void => {
  const configPath = path.join(ogiDirectory, 'config/option/general.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ steamCompatibilityTool: value })
  );
};

const locationFor = (
  root: string,
  accountId: string,
  shortcutsPath: string
): SteamLocation => {
  const userdataPath = path.dirname(path.dirname(shortcutsPath));
  return {
    root,
    loginUsersPath: path.join(root, 'config/loginusers.vdf'),
    user: {
      accountId,
      mostRecent: true,
      timestamp: 0,
      userdataPath,
      shortcutsPath,
    },
  };
};

const processLayer = Layer.succeed(SteamProcess, {
  status: () => Effect.succeed(false),
  shutdownAndWait: () => Effect.void,
  startAndWait: () => Effect.void,
});

describe('Steam service', () => {
  test('does not report multiple users for one physical shortcuts file', async () => {
    const appID = 3631290;
    const appInfo = libraryInfo(appID);
    writeLibraryInfo(appInfo);

    const steamRoot = path.join(ogiDirectory, 'steam');
    const steamAlias = path.join(ogiDirectory, 'steam-alias');
    const shortcutsPath = path.join(
      steamRoot,
      'userdata/100/config/shortcuts.vdf'
    );
    fs.mkdirSync(path.dirname(shortcutsPath), { recursive: true });
    fs.symlinkSync(steamRoot, steamAlias, 'dir');
    const aliasShortcutsPath = path.join(
      steamAlias,
      'userdata/100/config/shortcuts.vdf'
    );
    fs.writeFileSync(shortcutsPath, 'fixture');

    const root: BinaryVdfObject = new Map();
    const seeded = upsertShortcut(root, {
      gameId: appID,
      executable: process.execPath,
      appName: `${appInfo.name} (${appInfo.version})`,
      startDir: path.dirname(process.execPath),
      launchOptions: `--game-id=${appID} --no-sandbox`,
      tags: ['OpenGameInstaller'],
    });
    const locations = [
      locationFor(steamRoot, '100', shortcutsPath),
      locationFor(steamAlias, '100', aliasShortcutsPath),
    ];
    const repositoryLayer = Layer.succeed(SteamRepository, {
      locate: Effect.succeed(locations[0]),
      locateAll: Effect.succeed(locations),
      readShortcuts: (location) =>
        Effect.succeed({ root, shortcutsPath: location.user.shortcutsPath }),
      writeShortcuts: () => Effect.void,
      modifyShortcuts: (_location, mutation) =>
        mutation({
          root,
          shortcutsPath,
          configPath: path.join(location.root, 'config/config.vdf'),
          configSource: '',
          commit: () => Effect.void,
          rollback: Effect.void,
        }),
    });
    const layer = SteamServiceLive.pipe(
      Layer.provide(Layer.merge(repositoryLayer, processLayer))
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SteamService).lookup(appID);
      }).pipe(Effect.provide(layer))
    );

    expect(result.appId).toBe(seeded.appId);
  });

  test('keeps distinct Steam user shortcuts as a conflict', async () => {
    const appID = 3631292;
    const appInfo = libraryInfo(appID);
    writeLibraryInfo(appInfo);
    const locations = ['first', 'second'].map((name, index) => {
      const root = path.join(ogiDirectory, name);
      const shortcutsPath = path.join(
        root,
        `userdata/${index + 1}/config/shortcuts.vdf`
      );
      return locationFor(root, String(index + 1), shortcutsPath);
    });
    const roots = locations.map(() => {
      const root: BinaryVdfObject = new Map();
      upsertShortcut(root, {
        gameId: appID,
        executable: process.execPath,
        appName: appInfo.name,
        startDir: path.dirname(process.execPath),
        launchOptions: `--game-id=${appID} --no-sandbox`,
        tags: ['OpenGameInstaller'],
      });
      return root;
    });
    const repositoryLayer = Layer.succeed(SteamRepository, {
      locate: Effect.succeed(locations[0]),
      locateAll: Effect.succeed(locations),
      readShortcuts: (location) => {
        const index = locations.indexOf(location);
        return Effect.succeed({
          root: roots[index],
          shortcutsPath: location.user.shortcutsPath,
        });
      },
      writeShortcuts: () => Effect.void,
      modifyShortcuts: () => Effect.die('unexpected mutation'),
    });
    const layer = SteamServiceLive.pipe(
      Layer.provide(Layer.merge(repositoryLayer, processLayer))
    );

    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          return yield* (yield* SteamService).lookup(appID);
        }).pipe(Effect.provide(layer))
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left._tag).toBe('SteamShortcutConflictError');
    }
  });

  test('replaces an opaque versioned shortcut name with the plain game name', async () => {
    const appID = 3631291;
    const appInfo = libraryInfo(appID);
    writeLibraryInfo(appInfo);

    const steamRoot = path.join(ogiDirectory, 'naming-steam');
    const shortcutsPath = path.join(
      steamRoot,
      'userdata/100/config/shortcuts.vdf'
    );
    const location = locationFor(steamRoot, '100', shortcutsPath);
    const root: BinaryVdfObject = new Map();
    const existing = upsertShortcut(root, {
      gameId: appID,
      executable: process.execPath,
      appName: `${appInfo.name} (${appInfo.version})`,
      startDir: path.dirname(process.execPath),
      launchOptions: `--game-id=${appID} --no-sandbox`,
      tags: ['OpenGameInstaller'],
    });
    const gridDirectory = path.join(location.user.userdataPath, 'config/grid');
    fs.mkdirSync(gridDirectory, { recursive: true });
    fs.writeFileSync(path.join(gridDirectory, `${existing.appId}p.png`), 'art');
    fs.mkdirSync(path.join(ogiDirectory, 'config/option'), { recursive: true });
    fs.writeFileSync(
      path.join(ogiDirectory, 'config/option/steamgriddb.json'),
      JSON.stringify({ apiKey: 'test-key' })
    );
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      fetchUrls.push(url);
      const data = url.includes('/search/autocomplete/') ? [{ id: 1 }] : [];
      return new Response(JSON.stringify({ success: true, data }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    let committedConfig = '';
    const repositoryLayer = Layer.succeed(SteamRepository, {
      locate: Effect.succeed(location),
      locateAll: Effect.succeed([location]),
      readShortcuts: () => Effect.succeed({ root, shortcutsPath }),
      writeShortcuts: () => Effect.void,
      modifyShortcuts: (_location, mutation) =>
        mutation({
          root,
          shortcutsPath,
          configPath: path.join(location.root, 'config/config.vdf'),
          configSource: '',
          commit: (options) =>
            Effect.sync(() => {
              committedConfig = options?.configSource ?? '';
            }),
          rollback: Effect.void,
        }),
    });
    const expectedAppId = generateNonSteamAppId(
      appInfo.launchExecutable,
      appInfo.name,
      appID
    );
    const calls: string[] = [];
    const runningProcessLayer = Layer.succeed(SteamProcess, {
      status: () => Effect.succeed(true),
      shutdownAndWait: () =>
        Effect.sync(() => {
          calls.push('shutdown');
        }),
      startAndWait: () =>
        Effect.sync(() => {
          expect(
            fs.existsSync(path.join(gridDirectory, `${expectedAppId}p.png`))
          ).toBe(true);
          expect(fetchUrls[0]).toContain(encodeURIComponent(appInfo.name));
          expect(fetchUrls[0]).not.toContain(encodeURIComponent(`(${appID})`));
          calls.push('start');
        }),
    });
    const layer = SteamServiceLive.pipe(
      Layer.provide(Layer.merge(repositoryLayer, runningProcessLayer))
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SteamService).add({
          appID,
          allowSteamShutdown: true,
        });
      }).pipe(Effect.provide(layer))
    );

    const [shortcut] = readShortcuts(serializeBinaryVdf(root)).shortcuts;
    expect(shortcut.appName).toBe(appInfo.name);
    expect(shortcut.executable).toBe(`"${appInfo.launchExecutable}"`);
    expect(shortcut.fields.get('StartDir')).toEqual({
      type: 1,
      value: `"${appInfo.cwd}"`,
    });
    expect(shortcut.launchOptions).toBe(
      `"${process.execPath}" --game-id=${appID} --no-sandbox -- %command%`
    );
    expect(committedConfig).toContain(`"${result.steamAppId}"`);
    expect(committedConfig).toContain('"name"\t"proton_experimental"');
    expect(
      fs.readFileSync(
        path.join(gridDirectory, `${result.steamAppId}p.png`),
        'utf8'
      )
    ).toBe('art');
    expect(
      fs.existsSync(path.join(gridDirectory, `${existing.appId}p.png`))
    ).toBe(true);
    expect(calls).toEqual(['shutdown', 'start']);
  });

  test('moves compatibility mappings to the game executable shortcut and clears them', async () => {
    const appID = 3631293;
    const appInfo = libraryInfo(appID);
    writeLibraryInfo(appInfo);
    writeCompatibilityTool('GE-Proton9-20');

    const steamRoot = path.join(ogiDirectory, 'compatibility-steam');
    const shortcutsPath = path.join(
      steamRoot,
      'userdata/100/config/shortcuts.vdf'
    );
    const location = locationFor(steamRoot, '100', shortcutsPath);
    const root: BinaryVdfObject = new Map();
    const legacy = upsertShortcut(root, {
      gameId: appID,
      executable: process.execPath,
      appName: appInfo.name,
      startDir: path.dirname(process.execPath),
      launchOptions: `--game-id=${appID} --no-sandbox`,
      tags: ['OpenGameInstaller'],
    });
    let currentConfig = updateSteamCompatToolMapping(
      '',
      legacy.appId,
      'proton_experimental'
    );
    const repositoryLayer = Layer.succeed(SteamRepository, {
      locate: Effect.succeed(location),
      locateAll: Effect.succeed([location]),
      readShortcuts: () => Effect.succeed({ root, shortcutsPath }),
      writeShortcuts: () => Effect.void,
      modifyShortcuts: (_location, mutation) =>
        mutation({
          root,
          shortcutsPath,
          configPath: path.join(location.root, 'config/config.vdf'),
          configSource: currentConfig,
          commit: (options) =>
            Effect.sync(() => {
              currentConfig = options?.configSource ?? currentConfig;
            }),
          rollback: Effect.void,
        }),
    });
    const layer = SteamServiceLive.pipe(
      Layer.provide(Layer.merge(repositoryLayer, processLayer))
    );

    const added = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SteamService).add({ appID });
      }).pipe(Effect.provide(layer))
    );

    expect(added.steamAppId).toBe(
      generateNonSteamAppId(appInfo.launchExecutable, appInfo.name, appID)
    );
    expect(currentConfig).not.toContain(`"${legacy.appId}"`);
    expect(currentConfig).toContain(`"${added.steamAppId}"`);
    expect(currentConfig).toContain('"name"\t"GE-Proton9-20"');

    writeCompatibilityTool('');
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* SteamService).add({ appID });
      }).pipe(Effect.provide(layer))
    );

    expect(currentConfig).not.toContain(`"${added.steamAppId}"`);
  });

  test('removes the compatibility mapping with the shortcut', async () => {
    const appID = 3631295;
    const appInfo = libraryInfo(appID);
    writeLibraryInfo(appInfo);
    const steamRoot = path.join(ogiDirectory, 'remove-compatibility-steam');
    const shortcutsPath = path.join(
      steamRoot,
      'userdata/100/config/shortcuts.vdf'
    );
    const location = locationFor(steamRoot, '100', shortcutsPath);
    const root: BinaryVdfObject = new Map();
    const shortcut = upsertShortcut(root, {
      gameId: appID,
      executable: appInfo.launchExecutable,
      appName: appInfo.name,
      startDir: appInfo.cwd,
      launchOptions: `"${process.execPath}" --game-id=${appID} --no-sandbox -- %command%`,
      tags: ['OpenGameInstaller'],
    });
    let currentConfig = updateSteamCompatToolMapping(
      '',
      shortcut.appId,
      'proton_experimental'
    );
    const repositoryLayer = Layer.succeed(SteamRepository, {
      locate: Effect.succeed(location),
      locateAll: Effect.succeed([location]),
      readShortcuts: () => Effect.succeed({ root, shortcutsPath }),
      writeShortcuts: () => Effect.void,
      modifyShortcuts: (_location, mutation) =>
        mutation({
          root,
          shortcutsPath,
          configPath: path.join(location.root, 'config/config.vdf'),
          configSource: currentConfig,
          commit: (options) =>
            Effect.sync(() => {
              currentConfig = options?.configSource ?? currentConfig;
            }),
          rollback: Effect.void,
        }),
    });
    const layer = SteamServiceLive.pipe(
      Layer.provide(Layer.merge(repositoryLayer, processLayer))
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* SteamService).remove({ appID });
      }).pipe(Effect.provide(layer))
    );

    expect(readShortcuts(serializeBinaryVdf(root)).shortcuts).toHaveLength(0);
    expect(currentConfig).not.toContain(`"${shortcut.appId}"`);
  });

  test('uses the executable directory when the game directory is blank', async () => {
    const appID = 3631294;
    const appInfo = { ...libraryInfo(appID), cwd: '   ' };
    writeLibraryInfo(appInfo);
    const steamRoot = path.join(ogiDirectory, 'start-dir-steam');
    const shortcutsPath = path.join(
      steamRoot,
      'userdata/100/config/shortcuts.vdf'
    );
    const location = locationFor(steamRoot, '100', shortcutsPath);
    const root: BinaryVdfObject = new Map();
    const repositoryLayer = Layer.succeed(SteamRepository, {
      locate: Effect.succeed(location),
      locateAll: Effect.succeed([location]),
      readShortcuts: () => Effect.succeed({ root, shortcutsPath }),
      writeShortcuts: () => Effect.void,
      modifyShortcuts: (_location, mutation) =>
        mutation({
          root,
          shortcutsPath,
          configPath: path.join(location.root, 'config/config.vdf'),
          configSource: '',
          commit: () => Effect.void,
          rollback: Effect.void,
        }),
    });
    const layer = SteamServiceLive.pipe(
      Layer.provide(Layer.merge(repositoryLayer, processLayer))
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* SteamService).add({ appID });
      }).pipe(Effect.provide(layer))
    );

    const [shortcut] = readShortcuts(serializeBinaryVdf(root)).shortcuts;
    expect(shortcut.fields.get('StartDir')).toEqual({
      type: 1,
      value: `"${path.dirname(appInfo.launchExecutable)}"`,
    });
  });
});
