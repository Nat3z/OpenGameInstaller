import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const moduleDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ogi-steam-grid-db-module-')
);
process.env.OGI_DIRECTORY = moduleDirectory;
mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => moduleDirectory },
}));

let getSteamGridDbConfigPath: typeof import('../src/electron/lib/steam-grid-db.js').getSteamGridDbConfigPath;
let migrateLegacySteamGridDbKey: typeof import('../src/electron/lib/steam-grid-db.js').migrateLegacySteamGridDbKey;
let parseLegacySteamGridDbKey: typeof import('../src/electron/lib/steam-grid-db.js').parseLegacySteamGridDbKey;
let readSteamGridDbKey: typeof import('../src/electron/lib/steam-grid-db.js').readSteamGridDbKey;
let writeSteamGridDbKey: typeof import('../src/electron/lib/steam-grid-db.js').writeSteamGridDbKey;

beforeAll(async () => {
  ({
    getSteamGridDbConfigPath,
    migrateLegacySteamGridDbKey,
    parseLegacySteamGridDbKey,
    readSteamGridDbKey,
    writeSteamGridDbKey,
  } = await import('../src/electron/lib/steam-grid-db.js'));
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
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SteamGridDB configuration', () => {
  test('stores a trimmed key for OOBE and settings', () => {
    const baseDirectory = temporaryDirectory();

    writeSteamGridDbKey('  configured-key  ', baseDirectory);

    expect(readSteamGridDbKey(baseDirectory)).toBe('configured-key');
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
    const baseDirectory = temporaryDirectory();
    const homeDirectory = temporaryDirectory();
    const legacyPath = path.join(
      homeDirectory,
      '.config/steamtinkerlaunch/global.conf'
    );
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, 'SGDBAPIKEY="migrated-key"\n');

    expect(migrateLegacySteamGridDbKey({ baseDirectory, homeDirectory })).toBe(
      'migrated'
    );
    expect(readSteamGridDbKey(baseDirectory)).toBe('migrated-key');
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
      const baseDirectory = temporaryDirectory();
      const homeDirectory = temporaryDirectory();
      const xdgConfigHome = temporaryDirectory();
      const legacyPath = candidate.legacyPath(homeDirectory, xdgConfigHome);
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, `SGDBAPIKEY="candidate-${index}"\n`);

      expect(
        migrateLegacySteamGridDbKey({
          baseDirectory,
          ...candidate.options(homeDirectory, xdgConfigHome),
        })
      ).toBe('migrated');
      expect(readSteamGridDbKey(baseDirectory)).toBe(`candidate-${index}`);
    }
  });

  test('does not overwrite an existing OGI key', () => {
    const baseDirectory = temporaryDirectory();
    const homeDirectory = temporaryDirectory();
    const legacyPath = path.join(
      homeDirectory,
      '.config/steamtinkerlaunch/global.conf'
    );
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, 'SGDBAPIKEY="legacy-key"\n');
    writeSteamGridDbKey('current-key', baseDirectory);

    expect(migrateLegacySteamGridDbKey({ baseDirectory, homeDirectory })).toBe(
      'already-configured'
    );
    expect(readSteamGridDbKey(baseDirectory)).toBe('current-key');
  });

  test('leaves the new config absent when no legacy key exists', () => {
    const baseDirectory = temporaryDirectory();
    const homeDirectory = temporaryDirectory();

    expect(migrateLegacySteamGridDbKey({ baseDirectory, homeDirectory })).toBe(
      'not-found'
    );
    expect(fs.existsSync(getSteamGridDbConfigPath(baseDirectory))).toBe(false);
  });
});
