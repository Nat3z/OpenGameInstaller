import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertSteamClosed,
  type BinaryVdfObject,
  type BinaryVdfValue,
  findShortcut,
  generateNonSteamAppId,
  getNonSteamLaunchId,
  getSteamCompatDataPath,
  locateSteam,
  parseTextVdf,
  readShortcuts,
  removeShortcut,
  selectSteamUser,
  serializeBinaryVdf,
  serializeTextVdf,
  setCompatibilityTool,
  updateShortcutsFile,
  upsertShortcut,
} from '../src/electron/lib/steam-vdf.js';

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogi-steam-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const field = (value: string | number): BinaryVdfValue =>
  typeof value === 'string' ? { type: 1, value } : { type: 2, value };

const shortcutRoot = (): BinaryVdfObject =>
  new Map([
    [
      'shortcuts',
      {
        type: 0,
        value: new Map([
          [
            '0',
            {
              type: 0,
              value: new Map([
                ['appid', field(0x81234567 | 0)],
                ['AppName', field('Existing Game')],
                ['Exe', field('"/games/existing.exe"')],
                ['CustomField', field('preserve me')],
              ]),
            },
          ],
        ]),
      },
    ],
    ['FutureRootField', { type: 7, value: 42n }],
  ]);

describe('Steam binary VDF shortcuts', () => {
  test('preserves existing entries and unknown fields while adding and updating', () => {
    const root = shortcutRoot();
    upsertShortcut(root, {
      appName: 'New Game (2.0)',
      executable: '/opt/OpenGameInstaller.AppImage',
      startDir: '/opt',
      launchOptions: '--game-id=99',
    });

    const firstPass = readShortcuts(serializeBinaryVdf(root));
    expect(firstPass.shortcuts).toHaveLength(2);
    expect(
      findShortcut(firstPass.shortcuts, ['Existing Game'])?.fields.get(
        'CustomField'
      )
    ).toEqual(field('preserve me'));
    expect(firstPass.root.get('FutureRootField')).toEqual({
      type: 7,
      value: 42n,
    });

    upsertShortcut(firstPass.root, {
      appName: 'New Game (2.1)',
      previousNames: ['New Game (2.0)'],
      executable: '/opt/OpenGameInstaller.AppImage',
      startDir: '/opt',
      launchOptions: '--game-id=99 --no-sandbox',
    });
    const updated = readShortcuts(serializeBinaryVdf(firstPass.root));
    expect(updated.shortcuts).toHaveLength(2);
    expect(findShortcut(updated.shortcuts, ['New Game (2.1)'])).toBeDefined();
  });

  test('generates stable shortcut and launch IDs for versioned names and gui paths', () => {
    const appId = generateNonSteamAppId('/games/gui/Game.exe', 'Game (1.2.3)');
    expect(appId).toBe(2504465288);
    expect(getNonSteamLaunchId(appId)).toBe(
      ((2504465288n << 32n) | 0x02000000n).toString()
    );

    const root = shortcutRoot();
    upsertShortcut(root, {
      appName: 'Game (1.2.3)',
      executable: '/games/gui/Game.exe',
      startDir: '/games/gui',
    });
    const { shortcuts } = readShortcuts(serializeBinaryVdf(root));
    expect(
      findShortcut(shortcuts, ['Game (1.2.3)'], '/games/gui/Game.exe')?.appId
    ).toBe(appId);
    expect(findShortcut(shortcuts, ['Game'])).toBeUndefined();
  });

  test('removes only the selected shortcut', () => {
    const root = shortcutRoot();
    upsertShortcut(root, {
      appName: 'Remove Me',
      executable: '/opt/ogi',
      startDir: '/opt',
    });
    expect(
      removeShortcut(root, (shortcut) => shortcut.appName === 'Remove Me')
    ).toBe(true);
    const { shortcuts } = readShortcuts(serializeBinaryVdf(root));
    expect(shortcuts.map((shortcut) => shortcut.appName)).toEqual([
      'Existing Game',
    ]);
  });
});

const writeLoginUsers = (
  root: string,
  users: Array<{
    steamId: string;
    name: string;
    timestamp: number;
    mostRecent?: boolean;
  }>
): void => {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  const body = users
    .map(
      (user) =>
        `"${user.steamId}"\n{\n"AccountName" "${user.name}"\n"Timestamp" "${user.timestamp}"\n${
          user.mostRecent === undefined
            ? ''
            : `"MostRecent" "${user.mostRecent ? 1 : 0}"\n`
        }}\n`
    )
    .join('');
  fs.writeFileSync(
    path.join(root, 'config/loginusers.vdf'),
    `"users"\n{\n${body}}\n`
  );
};

describe('Steam installation and account discovery', () => {
  test('selects MostRecent from multiple userdata accounts', () => {
    const root = path.join(temporaryDirectory(), 'Steam gui install');
    fs.mkdirSync(path.join(root, 'userdata/100/config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'userdata/200/config'), { recursive: true });
    writeLoginUsers(root, [
      {
        steamId: '76561197960265828',
        name: 'older',
        timestamp: 500,
        mostRecent: false,
      },
      {
        steamId: '76561197960265928',
        name: 'active',
        timestamp: 100,
        mostRecent: true,
      },
    ]);
    expect(selectSteamUser(root)?.accountId).toBe('200');
    expect(locateSteam(['/missing', root])?.root).toBe(root);
  });

  test('uses newest timestamp when loginusers has no MostRecent fields', () => {
    const root = path.join(temporaryDirectory(), 'gui/Steam');
    fs.mkdirSync(path.join(root, 'userdata/0/config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'userdata/100/config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'userdata/200/config'), { recursive: true });
    writeLoginUsers(root, [
      { steamId: '76561197960265828', name: 'old', timestamp: 100 },
      { steamId: '76561197960265928', name: 'new', timestamp: 900 },
    ]);
    expect(selectSteamUser(root)?.accountId).toBe('200');
    expect(getSteamCompatDataPath(root, 1234)).toBe(
      path.join(root, 'steamapps/compatdata/1234')
    );
  });

  test('chooses the active account across multiple Steam installations', () => {
    const parent = temporaryDirectory();
    const oldRoot = path.join(parent, 'old Steam');
    const activeRoot = path.join(parent, 'gui/current Steam');
    fs.mkdirSync(path.join(oldRoot, 'userdata/100/config'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(activeRoot, 'userdata/200/config'), {
      recursive: true,
    });
    writeLoginUsers(oldRoot, [
      {
        steamId: '76561197960265828',
        name: 'old',
        timestamp: 800,
        mostRecent: false,
      },
    ]);
    writeLoginUsers(activeRoot, [
      {
        steamId: '76561197960265928',
        name: 'active',
        timestamp: 100,
        mostRecent: true,
      },
    ]);
    expect(locateSteam([oldRoot, activeRoot])?.root).toBe(activeRoot);
  });
});

describe('safe Steam configuration writes', () => {
  test('refuses shortcut writes while Steam is open and leaves the file unchanged', () => {
    const filePath = path.join(temporaryDirectory(), 'shortcuts.vdf');
    const original = serializeBinaryVdf(shortcutRoot());
    fs.writeFileSync(filePath, original);
    expect(() => updateShortcutsFile(filePath, () => {}, true)).toThrow(
      'Close Steam'
    );
    expect(fs.readFileSync(filePath)).toEqual(original);
    expect(() => assertSteamClosed(true)).toThrow('shortcuts.vdf');
  });

  test('updates one compatibility mapping while preserving other configuration', () => {
    const configPath = path.join(temporaryDirectory(), 'config.vdf');
    const initial = new Map([
      ['Unrelated', 'keep'],
      [
        'InstallConfigStore',
        new Map([
          [
            'Software',
            new Map([
              [
                'Valve',
                new Map([
                  [
                    'Steam',
                    new Map([
                      ['OtherSetting', 'keep too'],
                      [
                        'CompatToolMapping',
                        new Map([['123', new Map([['name', 'GE-Proton']])]]),
                      ],
                    ]),
                  ],
                ]),
              ],
            ]),
          ],
        ]),
      ],
    ]);
    fs.writeFileSync(configPath, serializeTextVdf(initial));
    setCompatibilityTool(configPath, 456, 'proton_experimental', false);
    const parsed = parseTextVdf(fs.readFileSync(configPath, 'utf8'));
    expect(parsed.get('Unrelated')).toBe('keep');
    const serialized = serializeTextVdf(parsed);
    expect(serialized).toContain('GE-Proton');
    expect(serialized).toContain('proton_experimental');
  });
});
