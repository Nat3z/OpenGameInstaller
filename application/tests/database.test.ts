import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { AppDatabase } from '../src/electron/database/database.js';
import { importLegacyState } from '../src/electron/database/legacy-import.js';

const migrations = path.join(import.meta.dir, '../drizzle');
const open = (file = ':memory:') =>
  new AppDatabase(drizzle(new Database(file)), migrations);

const game = (appID: number) => ({
  appID,
  name: `Game ${appID}`,
  version: '1.0.0',
  cwd: `/games/${appID}`,
  launchExecutable: 'game.exe',
  capsuleImage: '',
  coverImage: '',
  storefront: 'steam',
  addonsource: 'test',
});

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('AppDatabase', () => {
  test('settings start from defaults and patch in place', () => {
    const db = open();
    expect(db.getSettings().theme).toBe('light');
    expect(db.getSettings().marketplaceSources).toEqual([
      'https://ogi-marketplace.nat3z.com',
    ]);
    db.updateSettings({ theme: 'dark', addons: ['git@x/y'] });
    expect(db.getSettings()).toMatchObject({
      theme: 'dark',
      addons: ['git@x/y'],
    });
  });

  test('library round-trips optional fields and launch recency', () => {
    const db = open();
    db.saveGame({
      ...game(1),
      umu: { umuId: 'umu:1', dllOverrides: ['d3d9'] },
    });
    db.saveGame(game(2));
    db.saveGame(game(3));
    expect(db.getGame(1)?.umu?.dllOverrides).toEqual(['d3d9']);
    expect(db.getGame(2)).not.toHaveProperty('umu');
    db.markGameLaunched(2);
    db.markGameLaunched(3);
    expect(db.listGames().map((entry) => entry.appID)).toEqual([3, 2, 1]);
    db.saveGame({ ...game(3), version: '2.0.0' });
    expect(db.listGames()[0]).toMatchObject({ appID: 3, version: '2.0.0' });
  });

  test('staged removals restore on rollback and after a crash', () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ogi-db-')),
      'db'
    );
    temporary.push(path.dirname(file));
    let db = open(file);
    db.saveGame(game(7));
    db.saveGame(game(8));
    db.stageGameRemoval(7).rollback();
    expect(db.hasGame(7)).toBe(true);
    db.stageGameRemoval(8);
    expect(db.hasGame(8)).toBe(false);
    db.close();
    db = open(file);
    expect(db.hasGame(8)).toBe(true);
    db.stageGameRemoval(8).commit();
    expect(db.hasGame(8)).toBe(false);
    db.close();
  });

  test('addon config is replaced wholesale', () => {
    const db = open();
    expect(db.getAddonConfig('x')).toBeNull();
    db.setAddonConfig('x', { a: 1, b: 'two' });
    db.setAddonConfig('x', { c: true });
    expect(db.getAddonConfig('x')).toEqual({ c: true });
  });

  test('update state and image cache round-trip', () => {
    const db = open();
    db.setUpdateState({
      requiredReadds: [{ appID: 1 }, { appID: 2, steamAppId: 9 }],
      dismissedUpdates: [{ appID: 3, updateVersion: '2' }],
    });
    expect(db.getUpdateState()).toEqual({
      requiredReadds: [{ appID: 1 }, { appID: 2, steamAppId: 9 }],
      dismissedUpdates: [{ appID: 3, updateVersion: '2' }],
    });
    db.putCachedImage('k', 'image/png', new Uint8Array([1, 2, 3]));
    expect(Array.from(db.getCachedImage('k')!.bytes)).toEqual([1, 2, 3]);
  });
});

describe('legacy import', () => {
  test('imports the JSON layout once and leaves it in place', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogi-legacy-'));
    temporary.push(directory);
    const write = (relative: string, value: unknown) => {
      const target = path.join(directory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        typeof value === 'string' ? value : JSON.stringify(value)
      );
    };
    write('config/option/general.json', {
      theme: 'synthwave',
      fileDownloadLocation: '/dl',
      addons: ['git@a/b'],
      torrentClient: 'qbittorrent',
      marketplaceSources: [],
    });
    write('config/option/realdebrid.json', {
      debridApiKey: 'rd',
      torboxApiKey: '',
    });
    write('config/option/developer.json', { disableSecretCheck: true });
    write('config/option/steamgriddb.json', { apiKey: ' sg ' });
    write('config/option/installed.json', { installed: true });
    write('config/option/lastVersion.txt', '4.3.0\n');
    write('config/my-addon.json', {
      limit: 3,
      on: true,
      name: 'x',
      nested: {},
    });
    write('library/10.json', game(10));
    write('library/11.json', game(11));
    write('library/12.json.ogi-removing-1-2', game(12));
    write('library/broken.json', 'nope');
    write('internals/apps.json', [11, 10, 99]);
    write('internals/update-state.json', {
      requiredReadds: [{ appID: 10, steamAppId: 5 }, 3],
      dismissedUpdates: [{ appID: 11, updateVersion: '9' }],
    });
    write('in-progress-downloads/d1.json', {
      id: 'd1',
      updatedAt: 5,
      downloadInfo: { id: 'd1', appID: 10, status: 'paused' },
    });
    write('failed-setups/f1.json', {
      id: 'f1',
      timestamp: 6,
      retryCount: 1,
      downloadInfo: { id: 'f1', appID: 10 },
      setupData: {},
      error: 'boom',
      should: 'call-addon',
    });

    const db = open();
    expect(importLegacyState(directory, db)).toBe(true);
    expect(importLegacyState(directory, db)).toBe(false);
    expect(db.getSettings()).toMatchObject({
      theme: 'synthwave',
      fileDownloadLocation: '/dl',
      addons: ['git@a/b'],
      torrentClient: 'qbittorrent',
      marketplaceSources: ['https://ogi-marketplace.nat3z.com'],
      debridApiKey: 'rd',
      disableSecretCheck: true,
      steamGridDbApiKey: 'sg',
    });
    expect(db.getAppState()).toEqual({
      installed: true,
      oobeRestartRequired: false,
      lastVersion: '4.3.0',
    });
    expect(db.getAddonConfig('my-addon')).toEqual({
      limit: 3,
      on: true,
      name: 'x',
    });
    expect(db.listGames().map((entry) => entry.appID)).toEqual([11, 10, 12]);
    expect(db.getUpdateState()).toEqual({
      requiredReadds: [{ appID: 10, steamAppId: 5 }],
      dismissedUpdates: [{ appID: 11, updateVersion: '9' }],
    });
    expect(db.listDownloads()[0]).toMatchObject({ id: 'd1', updatedAt: 5 });
    expect(db.listFailedSetups()[0]).toMatchObject({ id: 'f1', error: 'boom' });
    expect(fs.existsSync(path.join(directory, 'library/10.json'))).toBe(true);
  });
});
