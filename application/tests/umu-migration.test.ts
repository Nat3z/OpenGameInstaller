import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { Effect, Fiber } from 'effect';
import { findSteamCompatDataPath } from '../src/electron/lib/steam-installation.js';
import {
  resolveLegacyPrefixSource,
  stagedPrefixMigration,
} from '../src/electron/lib/umu-prefix-migration.js';

const temporaryDirectories: string[] = [];
const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogi-umu-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const libraryInfo = (): LibraryInfo =>
  ({
    appID: 42,
    name: 'Migration Test',
    version: '1.0',
    cwd: '/games/test',
    launchExecutable: '/games/test/game.exe',
    umu: { umuId: 'umu:42' },
  }) as LibraryInfo;

const createPrefix = (root: string): string => {
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'pfx/drive_c/users/test'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(source, 'pfx/drive_c/users/test/save.dat'),
    'save data'
  );
  fs.symlinkSync('drive_c/users/test', path.join(source, 'pfx/current-user'));
  return source;
};

describe('staged UMU prefix migration', () => {
  test('prefers an explicitly configured prefix over Steam compatdata', () => {
    const root = temporaryDirectory();
    const configuredPrefix = createPrefix(path.join(root, 'configured'));
    const steamPrefix = createPrefix(path.join(root, 'steam'));

    expect(
      resolveLegacyPrefixSource({
        steamCompatDataPath: steamPrefix,
        configuredPrefix: path.join(configuredPrefix, 'pfx'),
      })
    ).toBe(configuredPrefix);
  });

  test('uses configured compatdata before detected Steam compatdata', () => {
    const root = temporaryDirectory();
    const configuredCompatData = createPrefix(path.join(root, 'configured'));
    const steamPrefix = createPrefix(path.join(root, 'steam'));

    expect(
      resolveLegacyPrefixSource({
        steamCompatDataPath: steamPrefix,
        configuredCompatDataPath: configuredCompatData,
      })
    ).toBe(configuredCompatData);
  });

  test('selects the Steam root containing the requested app prefix', () => {
    const root = temporaryDirectory();
    const firstSteamRoot = path.join(root, 'first-steam');
    const appSteamRoot = path.join(root, 'app-steam');
    fs.mkdirSync(path.join(firstSteamRoot, 'steamapps/compatdata'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(appSteamRoot, 'steamapps/compatdata/42'), {
      recursive: true,
    });

    expect(findSteamCompatDataPath(42, [firstSteamRoot, appSteamRoot])).toBe(
      path.join(appSteamRoot, 'steamapps/compatdata')
    );
  });

  test('copies, validates, promotes, and commits a prefix', async () => {
    const root = temporaryDirectory();
    const source = createPrefix(root);
    const finalPath = path.join(root, 'umu-prefix');
    let committed: LibraryInfo | undefined;
    const info = libraryInfo();

    const result = await Effect.runPromise(
      stagedPrefixMigration({
        libraryInfo: info,
        sourcePath: source,
        finalPath,
        commit: (value) => {
          committed = structuredClone(value);
        },
      })
    );

    expect(
      fs.readFileSync(
        path.join(finalPath, 'pfx/drive_c/users/test/save.dat'),
        'utf8'
      )
    ).toBe('save data');
    expect(fs.readlinkSync(path.join(finalPath, 'pfx/current-user'))).toBe(
      'drive_c/users/test'
    );
    expect(committed?.umu?.winePrefixPath).toBe(finalPath);
    expect(result.umu?.winePrefixPath).toBe(finalPath);
    expect(fs.existsSync(source)).toBe(true);
    expect(
      fs.readdirSync(root).filter((entry) => entry.includes('.ogi-migrate-'))
    ).toEqual([]);
  });

  test('reuses an empty pre-existing destination', async () => {
    const root = temporaryDirectory();
    const source = createPrefix(root);
    const finalPath = path.join(root, 'umu-prefix');
    fs.mkdirSync(finalPath);
    const info = libraryInfo();

    const result = await Effect.runPromise(
      stagedPrefixMigration({
        libraryInfo: info,
        sourcePath: source,
        finalPath,
        commit: () => {},
      })
    );

    expect(result.umu?.winePrefixPath).toBe(finalPath);
    expect(
      fs.readFileSync(
        path.join(finalPath, 'pfx/drive_c/users/test/save.dat'),
        'utf8'
      )
    ).toBe('save data');
  });

  test('recovers a prefix promoted before metadata commit', async () => {
    const root = temporaryDirectory();
    const finalPath = createPrefix(path.join(root, 'promoted'));
    fs.writeFileSync(
      path.join(finalPath, '.ogi-prefix-migration.json'),
      JSON.stringify({ appID: 42 })
    );
    const staleStaging = path.join(
      path.dirname(finalPath),
      `.${path.basename(finalPath)}.ogi-migrate-999999-abandoned`
    );
    fs.mkdirSync(staleStaging);
    const info = libraryInfo();
    let committed: LibraryInfo | undefined;

    const result = await Effect.runPromise(
      stagedPrefixMigration({
        libraryInfo: info,
        sourcePath: createPrefix(path.join(root, 'source')),
        finalPath,
        commit: (value) => {
          committed = structuredClone(value);
        },
      })
    );

    expect(result.umu?.winePrefixPath).toBe(finalPath);
    expect(committed?.umu?.winePrefixPath).toBe(finalPath);
    expect(
      fs.existsSync(path.join(finalPath, '.ogi-prefix-migration.json'))
    ).toBe(false);
    expect(fs.existsSync(staleStaging)).toBe(false);
  });

  test('does not overwrite a non-empty pre-existing destination', async () => {
    const root = temporaryDirectory();
    const source = createPrefix(root);
    const finalPath = path.join(root, 'umu-prefix');
    fs.mkdirSync(finalPath);
    fs.writeFileSync(path.join(finalPath, 'important.txt'), 'keep');
    const info = libraryInfo();

    const result = await Effect.runPromise(
      Effect.either(
        stagedPrefixMigration({
          libraryInfo: info,
          sourcePath: source,
          finalPath,
          commit: () => {},
        })
      )
    );

    expect(result._tag).toBe('Left');
    expect(fs.readFileSync(path.join(finalPath, 'important.txt'), 'utf8')).toBe(
      'keep'
    );
  });

  test('cancels an in-progress source prefix copy', async () => {
    const root = temporaryDirectory();
    const source = path.join(root, 'source');
    const sourceFiles = path.join(source, 'pfx/drive_c/files');
    fs.mkdirSync(sourceFiles, { recursive: true });
    for (let index = 0; index < 2_000; index += 1) {
      fs.writeFileSync(path.join(sourceFiles, `${index}.dat`), 'prefix data');
    }
    const finalPath = path.join(root, 'umu-prefix');
    let committed = false;
    const fiber = Effect.runFork(
      stagedPrefixMigration({
        libraryInfo: libraryInfo(),
        sourcePath: source,
        finalPath,
        commit: () => {
          committed = true;
        },
      })
    );

    while (
      !fs.readdirSync(root).some((entry) => entry.includes('.ogi-migrate-'))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await Effect.runPromise(Fiber.interrupt(fiber));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(committed).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(
      fs.readdirSync(root).filter((entry) => entry.includes('.ogi-migrate-'))
    ).toEqual([]);
  });

  test('does not promote or commit after migration is interrupted', async () => {
    const root = temporaryDirectory();
    const finalPath = path.join(root, 'umu-prefix');
    const info = libraryInfo();
    let committed = false;
    let signalStarted: (() => void) | undefined;
    let finishInitialization: (() => void) | undefined;
    let signalFinished: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      signalFinished = resolve;
    });
    const fiber = Effect.runFork(
      stagedPrefixMigration({
        libraryInfo: info,
        finalPath,
        initialize: async (stagingPath) => {
          signalStarted?.();
          await finish;
          if (fs.existsSync(stagingPath)) {
            fs.writeFileSync(path.join(stagingPath, 'system.reg'), 'registry');
          }
          signalFinished?.();
        },
        commit: () => {
          committed = true;
        },
      })
    );

    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));
    finishInitialization?.();
    await finished;

    expect(committed).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(
      fs.readdirSync(root).filter((entry) => entry.includes('.ogi-migrate-'))
    ).toEqual([]);
  });

  test('rolls back the promoted prefix when metadata commit fails', async () => {
    const root = temporaryDirectory();
    const source = createPrefix(root);
    const finalPath = path.join(root, 'umu-prefix');
    const info = libraryInfo();

    const result = await Effect.runPromise(
      Effect.either(
        stagedPrefixMigration({
          libraryInfo: info,
          sourcePath: source,
          finalPath,
          commit: () => {
            throw new Error('metadata write failed');
          },
        })
      )
    );

    expect(result._tag).toBe('Left');
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
    expect(
      fs.readdirSync(root).filter((entry) => entry.includes('.ogi-migrate-'))
    ).toEqual([]);
  });
});
