import { Database } from 'bun:sqlite';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { AppDatabase } from '../src/electron/database/database.js';

const moduleDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ogi-steam-grid-db-module-')
);
process.env.OGI_DIRECTORY = moduleDirectory;
mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => moduleDirectory },
}));

const migrations = path.join(import.meta.dir, '../drizzle');

let setDatabase: typeof import('../src/electron/database/index.js').setDatabase;
let migrateLegacySteamGridDbKey: typeof import('../src/electron/lib/steam-grid-db.js').migrateLegacySteamGridDbKey;
let parseLegacySteamGridDbKey: typeof import('../src/electron/lib/steam-grid-db.js').parseLegacySteamGridDbKey;
let readSteamGridDbKey: typeof import('../src/electron/lib/steam-grid-db.js').readSteamGridDbKey;
let writeSteamGridDbKey: typeof import('../src/electron/lib/steam-grid-db.js').writeSteamGridDbKey;

beforeAll(async () => {
  ({ setDatabase } = await import('../src/electron/database/index.js'));
  ({
    migrateLegacySteamGridDbKey,
    parseLegacySteamGridDbKey,
    readSteamGridDbKey,
    writeSteamGridDbKey,
  } = await import('../src/electron/lib/steam-grid-db.js'));
});

beforeEach(() => {
  setDatabase(new AppDatabase(drizzle(new Database(':memory:')), migrations));
});

const temporaryDirectories: string[] = [];
const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ogi-steam-grid-db-')
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  setDatabase(undefined);
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SteamGridDB configuration', () => {
  test('stores a trimmed key for OOBE and settings', () => {
    writeSteamGridDbKey('  configured-key  ');

    expect(readSteamGridDbKey()).toBe('configured-key');
  });

  test('parses the final valid legacy assignment', () => {
    expect(
      parseLegacySteamGridDbKey(`
SGDBAPIKEY="old-key"
export SGDBAPIKEY='new-key' # current
`)
    ).toBe('new-key');
  });

  test('migrates the legacy SteamTinkerLaunch key', () => {
    const homeDirectory = temporaryDirectory();
    const legacyPath = path.join(
      homeDirectory,
      '.config/steamtinkerlaunch/global.conf'
    );
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, 'SGDBAPIKEY="migrated-key"\n');

    expect(migrateLegacySteamGridDbKey({ homeDirectory })).toBe('migrated');
    expect(readSteamGridDbKey()).toBe('migrated-key');
  });

  test('supports XDG and Flatpak legacy config paths', () => {
    const cases = [
      {
        legacyPath: (_homeDirectory: string, xdgConfigHome: string) =>
          path.join(xdgConfigHome, 'steamtinkerlaunch/global.conf'),
        options: (homeDirectory: string, xdgConfigHome: string) => ({
          homeDirectory,
          xdgConfigHome,
        }),
      },
      {
        legacyPath: (homeDirectory: string) =>
          path.join(
            homeDirectory,
            '.var/app/com.valvesoftware.Steam/.config/steamtinkerlaunch/global.conf'
          ),
        options: (homeDirectory: string) => ({ homeDirectory }),
      },
    ];

    for (const [index, candidate] of cases.entries()) {
      setDatabase(
        new AppDatabase(drizzle(new Database(':memory:')), migrations)
      );
      const homeDirectory = temporaryDirectory();
      const xdgConfigHome = temporaryDirectory();
      const legacyPath = candidate.legacyPath(homeDirectory, xdgConfigHome);
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, `SGDBAPIKEY="candidate-${index}"\n`);

      expect(
        migrateLegacySteamGridDbKey(
          candidate.options(homeDirectory, xdgConfigHome)
        )
      ).toBe('migrated');
      expect(readSteamGridDbKey()).toBe(`candidate-${index}`);
    }
  });

  test('does not overwrite an existing OGI key', () => {
    const homeDirectory = temporaryDirectory();
    const legacyPath = path.join(
      homeDirectory,
      '.config/steamtinkerlaunch/global.conf'
    );
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, 'SGDBAPIKEY="legacy-key"\n');
    writeSteamGridDbKey('current-key');

    expect(migrateLegacySteamGridDbKey({ homeDirectory })).toBe(
      'already-configured'
    );
    expect(readSteamGridDbKey()).toBe('current-key');
  });

  test('leaves the key unset when no legacy key exists', () => {
    const homeDirectory = temporaryDirectory();

    expect(migrateLegacySteamGridDbKey({ homeDirectory })).toBe('not-found');
    expect(readSteamGridDbKey()).toBeUndefined();
  });
});
