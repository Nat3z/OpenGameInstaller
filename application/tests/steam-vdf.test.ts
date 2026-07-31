import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect } from 'effect';
import {
  getSteamCompatDataPath,
  getSteamRootCandidates,
  locateSteam,
  locateSteamLocations,
  selectSteamUser,
  writeFileAtomic,
} from '../src/electron/lib/steam-installation.js';
import {
  detectSteamRunning,
  findSteamProcessIds,
} from '../src/electron/lib/steam-process.js';
import {
  findOwnedShortcut,
  generateNonSteamAppId,
  getNonSteamLaunchId,
  readShortcuts,
  removeOwnedShortcut,
  upsertShortcut,
} from '../src/electron/lib/steam-shortcuts.js';
import {
  type BinaryVdfObject,
  type BinaryVdfValue,
  parseBinaryVdf,
  parseLoginUsers,
  serializeBinaryVdf,
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

const shortcutFields = (params: {
  appId: BinaryVdfValue;
  name: string;
  executable: string;
  launchOptions?: string;
  ogiTagged?: boolean;
}): BinaryVdfObject =>
  new Map([
    ['appid', params.appId],
    ['AppName', field(params.name)],
    ['Exe', field(`"${params.executable}"`)],
    ['LaunchOptions', field(params.launchOptions ?? '')],
    ['CustomField', field('preserve me')],
    [
      'tags',
      {
        type: 0,
        value: params.ogiTagged
          ? new Map([['0', field('OpenGameInstaller')]])
          : new Map(),
      },
    ],
  ]);

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
              value: shortcutFields({
                appId: { type: 4, value: 0x81234567 },
                name: 'Same Name',
                executable: '/games/manual.exe',
              }),
            },
          ],
          [
            '1',
            {
              type: 0,
              value: shortcutFields({
                appId: { type: 6, value: 0x82345678 },
                name: 'OGI Game (1.0)',
                executable: '/opt/OpenGameInstaller.AppImage',
                launchOptions: '--game-id=99 --no-sandbox',
                ogiTagged: true,
              }),
            },
          ],
        ]),
      },
    ],
    ['FutureRootField', { type: 7, value: 42n }],
  ]);

describe('Steam binary VDF codec and shortcut ownership', () => {
  test('parses Steam integer variants and preserves unknown fields', () => {
    const parsed = readShortcuts(serializeBinaryVdf(shortcutRoot()));
    expect(parsed.shortcuts.map((shortcut) => shortcut.appId)).toEqual([
      0x81234567, 0x82345678,
    ]);
    expect(parsed.root.get('FutureRootField')).toEqual({ type: 7, value: 42n });
    expect(parsed.shortcuts[0].fields.get('CustomField')).toEqual(
      field('preserve me')
    );
  });

  test('rejects truncated binary VDF', () => {
    const serialized = serializeBinaryVdf(shortcutRoot());
    expect(() => parseBinaryVdf(serialized.subarray(0, -2))).toThrow(
      'unexpected end of file'
    );
  });

  test('updates the OGI-owned shortcut and leaves a same-name user entry alone', () => {
    const root = shortcutRoot();
    const result = upsertShortcut(root, {
      gameId: 99,
      appName: 'Same Name',
      executable: '/opt/OpenGameInstaller.AppImage',
      startDir: '/opt',
      launchOptions: '--game-id=99 --no-sandbox',
      tags: ['OpenGameInstaller'],
      legacyNames: ['OGI Game (1.0)'],
    });
    const shortcuts = readShortcuts(serializeBinaryVdf(root)).shortcuts;
    expect(shortcuts).toHaveLength(2);
    expect(shortcuts[0].executable).toBe('"/games/manual.exe"');
    expect(
      findOwnedShortcut(shortcuts, {
        gameId: 99,
        executable: '/opt/OpenGameInstaller.AppImage',
      })?.appName
    ).toBe('Same Name');
    expect(result.appId).toBe(
      generateNonSteamAppId('/opt/OpenGameInstaller.AppImage', 'Same Name', 99)
    );
  });

  test('claims a known shortcut using its pre-update identity', () => {
    const root: BinaryVdfObject = new Map([
      [
        'shortcuts',
        {
          type: 0,
          value: new Map([
            [
              '0',
              {
                type: 0,
                value: shortcutFields({
                  appId: { type: 2, value: 0x81234567 | 0 },
                  name: 'OGI Game (1.0)',
                  executable: '/games/old/game.exe',
                  launchOptions:
                    '"/opt/OpenGameInstaller.AppImage" --game-id=99',
                }),
              },
            ],
          ]),
        },
      ],
    ]);

    const result = upsertShortcut(root, {
      gameId: 99,
      knownAppId: 0x81234567,
      appName: 'OGI Game (2.0)',
      executable: '/opt/OpenGameInstaller.AppImage',
      startDir: '/opt',
      launchOptions: '--game-id=99 --no-sandbox',
      tags: ['OpenGameInstaller'],
      legacyExecutables: ['/games/new/game.exe', '/games/old/game.exe'],
      legacyNames: ['OGI Game (2.0)', 'OGI Game', 'OGI Game (1.0)'],
    });

    expect(result.created).toBe(false);
    expect(readShortcuts(serializeBinaryVdf(root)).shortcuts).toHaveLength(1);
    expect(
      findOwnedShortcut(readShortcuts(serializeBinaryVdf(root)).shortcuts, {
        gameId: 99,
        executable: '/opt/OpenGameInstaller.AppImage',
      })?.appName
    ).toBe('OGI Game (2.0)');
  });

  test('does not claim a manual shortcut with the same legacy identity', () => {
    const root: BinaryVdfObject = new Map([
      [
        'shortcuts',
        {
          type: 0,
          value: new Map([
            [
              '0',
              {
                type: 0,
                value: shortcutFields({
                  appId: { type: 2, value: 0x81234567 | 0 },
                  name: 'OGI Game (1.0)',
                  executable: '/games/old/game.exe',
                }),
              },
            ],
          ]),
        },
      ],
    ]);

    expect(() =>
      upsertShortcut(root, {
        gameId: 99,
        knownAppId: 0x81234567,
        appName: 'OGI Game (2.0)',
        executable: '/opt/OpenGameInstaller.AppImage',
        startDir: '/opt',
        legacyExecutables: ['/games/old/game.exe'],
        legacyNames: ['OGI Game (1.0)'],
      })
    ).toThrow('is not owned by OpenGameInstaller');
  });

  test('rejects a known app ID owned by an unrelated shortcut', () => {
    const root = shortcutRoot();
    const before = serializeBinaryVdf(root);
    const identity = {
      gameId: 99,
      knownAppId: 0x81234567,
      executable: '/opt/OpenGameInstaller.AppImage',
    };

    expect(() =>
      upsertShortcut(root, {
        ...identity,
        appName: 'Same Name',
        startDir: '/opt',
        launchOptions: '--game-id=99 --no-sandbox',
        tags: ['OpenGameInstaller'],
      })
    ).toThrow('is not owned by OpenGameInstaller');
    expect(() => removeOwnedShortcut(root, identity)).toThrow(
      'is not owned by OpenGameInstaller'
    );
    expect(serializeBinaryVdf(root)).toEqual(before);
  });

  test('removes only the exact OGI-owned shortcut', () => {
    const root = shortcutRoot();
    expect(
      removeOwnedShortcut(root, {
        gameId: 99,
        executable: '/opt/OpenGameInstaller.AppImage',
      }).removed
    ).toBe(true);
    const shortcuts = readShortcuts(serializeBinaryVdf(root)).shortcuts;
    expect(shortcuts.map((shortcut) => shortcut.executable)).toEqual([
      '"/games/manual.exe"',
    ]);
  });

  test('generates distinct shortcut IDs for same-name games', () => {
    const first = generateNonSteamAppId(
      '/opt/OpenGameInstaller.AppImage',
      'Duplicate (1.0)',
      1
    );
    const second = generateNonSteamAppId(
      '/opt/OpenGameInstaller.AppImage',
      'Duplicate (1.0)',
      2
    );

    expect(first).not.toBe(second);
    expect(getNonSteamLaunchId(first)).not.toBe(getNonSteamLaunchId(second));
  });

  test('generates stable shortcut and launch IDs', () => {
    const appId = generateNonSteamAppId('/games/gui/Game.exe', 'Game (1.2.3)');
    expect(appId).toBe(2504465288);
    expect(getNonSteamLaunchId(appId)).toBe(
      ((2504465288n << 32n) | 0x02000000n).toString()
    );
  });
});

const writeLoginUsers = (
  root: string,
  users: Array<{
    steamId: string;
    timestamp: number;
    mostRecent?: boolean;
  }>
): void => {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  const body = users
    .map(
      (user) =>
        `"${user.steamId}"\n{\n"Timestamp" "${user.timestamp}"\n${
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

describe('Steam installation repository', () => {
  test('only enumerates lifecycle-supported Linux installations', () => {
    const candidates = getSteamRootCandidates('/home/test', 'linux');
    expect(candidates).toContain('/home/test/.steam/steam');
    expect(candidates).toContain(
      '/home/test/.var/app/com.valvesoftware.Steam/.local/share/Steam'
    );
    expect(candidates.some((candidate) => candidate.includes('/snap/'))).toBe(
      false
    );
  });

  test('selects the most recent account and installation', async () => {
    const parent = temporaryDirectory();
    const oldRoot = path.join(parent, 'old');
    const activeRoot = path.join(parent, 'active');
    fs.mkdirSync(path.join(oldRoot, 'userdata/100/config'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(activeRoot, 'userdata/200/config'), {
      recursive: true,
    });
    writeLoginUsers(oldRoot, [
      { steamId: '76561197960265828', timestamp: 800, mostRecent: false },
    ]);
    writeLoginUsers(activeRoot, [
      { steamId: '76561197960265928', timestamp: 100, mostRecent: true },
    ]);
    expect(
      (await Effect.runPromise(selectSteamUser(activeRoot))).accountId
    ).toBe('200');
    expect(
      (await Effect.runPromise(locateSteam([oldRoot, activeRoot]))).root
    ).toBe(activeRoot);
    expect(getSteamCompatDataPath(activeRoot, 123)).toBe(
      path.join(activeRoot, 'steamapps/compatdata/123')
    );
  });

  test('enumerates every Steam installation and userdata account', async () => {
    const parent = temporaryDirectory();
    const nativeRoot = path.join(parent, 'native');
    const flatpakRoot = path.join(parent, 'flatpak');
    fs.mkdirSync(path.join(nativeRoot, 'userdata/100/config'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(nativeRoot, 'userdata/200/config'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(flatpakRoot, 'userdata/300/config'), {
      recursive: true,
    });
    writeLoginUsers(nativeRoot, [
      { steamId: '76561197960265828', timestamp: 100 },
      { steamId: '76561197960265928', timestamp: 300, mostRecent: true },
    ]);
    writeLoginUsers(flatpakRoot, [
      { steamId: '76561197960266028', timestamp: 200 },
    ]);

    const locations = await Effect.runPromise(
      locateSteamLocations([nativeRoot, flatpakRoot])
    );

    expect(locations.map((location) => location.user.accountId)).toEqual([
      '200',
      '300',
      '100',
    ]);
  });

  test('reports malformed loginusers instead of silently selecting an account', async () => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, 'userdata/100/config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/loginusers.vdf'), '"users" {');
    const result = await Effect.runPromise(Effect.either(locateSteam([root])));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left')
      expect(result.left._tag).toBe('SteamVdfParseError');
  });

  test('writes atomically and leaves no temporary file', async () => {
    const directory = temporaryDirectory();
    const filePath = path.join(directory, 'config/shortcuts.vdf');
    await Effect.runPromise(writeFileAtomic(filePath, Buffer.from('fixture')));
    expect(fs.readFileSync(filePath, 'utf8')).toBe('fixture');
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['shortcuts.vdf']);
  });

  test('parses representative loginusers text with Unicode persona data', () => {
    const users = parseLoginUsers(
      '"users"\n{\n"76561197960265828"\n{\n"PersonaName" "測試"\n"MostRecent" "1"\n}\n}\n'
    );
    expect(users[0].personaName).toBe('測試');
    expect(users[0].mostRecent).toBe(true);
  });
});

describe('Steam process detection', () => {
  test('detects Steam in a proc-style fixture', async () => {
    const procRoot = temporaryDirectory();
    fs.mkdirSync(path.join(procRoot, '100'));
    fs.writeFileSync(path.join(procRoot, '100/comm'), 'steam\n');
    expect(await Effect.runPromise(detectSteamRunning('linux', procRoot))).toBe(
      true
    );
  });

  test('distinguishes native and Flatpak Steam processes', async () => {
    const procRoot = temporaryDirectory();
    fs.mkdirSync(path.join(procRoot, '100'));
    fs.writeFileSync(path.join(procRoot, '100/comm'), 'steam\n');
    fs.writeFileSync(path.join(procRoot, '100/cmdline'), '/usr/bin/steam');
    fs.mkdirSync(path.join(procRoot, '200'));
    fs.writeFileSync(path.join(procRoot, '200/comm'), 'steam\n');
    fs.writeFileSync(
      path.join(procRoot, '200/cgroup'),
      '/app.slice/app-flatpak-com.valvesoftware.Steam.scope'
    );

    expect(
      await Effect.runPromise(detectSteamRunning('linux', procRoot, 'native'))
    ).toBe(true);
    expect(
      await Effect.runPromise(detectSteamRunning('linux', procRoot, 'flatpak'))
    ).toBe(true);
    expect(
      await Effect.runPromise(findSteamProcessIds('linux', procRoot, 'native'))
    ).toEqual([100]);
    expect(
      await Effect.runPromise(findSteamProcessIds('linux', procRoot, 'flatpak'))
    ).toEqual([200]);
    fs.rmSync(path.join(procRoot, '100'), { recursive: true });
    expect(
      await Effect.runPromise(detectSteamRunning('linux', procRoot, 'native'))
    ).toBe(false);
  });

  test('surfaces failure to inspect the process table', async () => {
    const result = await Effect.runPromise(
      Effect.either(detectSteamRunning('linux', '/missing-ogi-proc'))
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left')
      expect(result.left._tag).toBe('SteamProcessError');
  });
});
