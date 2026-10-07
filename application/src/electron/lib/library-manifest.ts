import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Schema } from 'effect';
import { LibraryInfoSchema } from 'ogi-addon';
import {
  filesystemRoot,
  normalizeDeletePath,
  sharesDirectoryWithOtherGames,
} from '@/electron/lib/delete-guards.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

/**
 * Every installed game keeps a copy of its library entry in its folder so the
 * library can be rebuilt from disk, e.g. after swapping SD cards or
 * reconnecting a drive whose games were removed while it was gone. Paths
 * inside the folder are stored relative to it, and machine-specific state
 * (Wine prefix, Steam shortcut ids) is left out.
 */
export const MANIFEST_FILE = '.ogi-game.json';

/** Placeholder for the game folder in stored paths. */
const GAME_DIR = '{gameDir}';
/** How far below a scan root a game folder may sit. */
const MAX_SCAN_DEPTH = 4;
/** Staged update leftovers and dependency trees never hold a live game. */
const SKIPPED_DIRS = new Set(['old_files', 'node_modules']);

const ManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  game: LibraryInfoSchema,
});

export type FoundManifest = { path: string; game: LibraryInfo };

const portablePath = (path: string, cwd: string): string => {
  if (!isAbsolute(path)) return path;
  const inner = relative(cwd, path);
  return inner === '' ||
    inner === '..' ||
    inner.startsWith(`..${sep}`) ||
    isAbsolute(inner)
    ? path
    : `${GAME_DIR}/${inner.split(sep).join('/')}`;
};

const localPath = (path: string, dir: string): string =>
  path.startsWith(`${GAME_DIR}/`)
    ? join(dir, path.slice(GAME_DIR.length + 1))
    : path;

const mapPaths = (
  info: LibraryInfo,
  cwd: string,
  map: (path: string) => string
): LibraryInfo => ({
  ...info,
  cwd,
  launchExecutable: map(info.launchExecutable),
  ...(info.redistributables
    ? {
        redistributables: info.redistributables.map((redistributable) => ({
          ...redistributable,
          path: map(redistributable.path),
        })),
      }
    : {}),
});

/** Moves an entry to `dir`, carrying along paths that pointed inside its old folder. */
export const relocateGame = (info: LibraryInfo, dir: string): LibraryInfo =>
  mapPaths(info, dir, (path) => localPath(portablePath(path, info.cwd), dir));

const toManifest = (info: LibraryInfo): typeof ManifestSchema.Encoded => {
  const game = mapPaths(info, '.', (path) => portablePath(path, info.cwd));
  // Pending redistributables belong to this machine's prefix.
  delete game.redistributables;
  if (info.umu) {
    const { umuId, dllOverrides, protonVersion, store } = info.umu;
    game.umu = { umuId, dllOverrides, protonVersion, store };
  }
  return { version: 1, game };
};

// Writes are serialized so overlapping saves never interleave in one file,
// and atomic so a drive pulled mid-write never leaves a torn manifest.
const writeLock = Effect.unsafeMakeSemaphore(1);
// Bounds directory reads across a whole scan.
const readLimit = Effect.unsafeMakeSemaphore(16);

const writeManifest = (info: LibraryInfo): Effect.Effect<void> => {
  const file = join(info.cwd, MANIFEST_FILE);
  const contents = `${JSON.stringify(toManifest(info), null, 2)}\n`;
  return Effect.tryPromise(async () => {
    const stat = await fsp.stat(info.cwd).catch(() => null);
    if (!stat?.isDirectory()) return;
    const existing = await fsp.readFile(file, 'utf8').catch(() => null);
    if (existing === contents) return;
    const temporary = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, contents);
    await fsp.rename(temporary, file);
  }).pipe(
    Effect.catchAll((error) =>
      logger.warn(`[library] Could not write ${file}`, error)
    )
  );
};

/**
 * Mirrors games into their folders (only `appID` when given). Folders that are
 * shared with another game, or are home or a filesystem root, are skipped so a
 * manifest never claims a folder holding other installs.
 */
export const writeManifests = (
  games: readonly LibraryInfo[],
  appID?: number
): Effect.Effect<void> =>
  Effect.forEach(
    games.filter(
      (game) =>
        (appID === undefined || game.appID === appID) &&
        isAbsolute(game.cwd) &&
        ![homedir(), filesystemRoot()].some(
          (path) => normalizeDeletePath(path) === normalizeDeletePath(game.cwd)
        ) &&
        !sharesDirectoryWithOtherGames(game.appID, game.cwd, games)
    ),
    writeManifest,
    { concurrency: 4, discard: true }
  ).pipe(writeLock.withPermits(1));

/** The entry stored in `dir`, rebased onto it; null when absent or invalid. */
export const readManifest = (dir: string): Effect.Effect<LibraryInfo | null> =>
  Effect.tryPromise(() => fsp.readFile(join(dir, MANIFEST_FILE), 'utf8')).pipe(
    Effect.flatMap((contents) =>
      Effect.try(() => JSON.parse(contents) as unknown)
    ),
    Effect.flatMap(Schema.decodeUnknown(ManifestSchema)),
    Effect.map(({ game }) =>
      mapPaths(game, dir, (path) => localPath(path, dir))
    ),
    Effect.catchAll(() => Effect.succeed(null))
  );

/** Drops the manifest in `dir` if it belongs to `appID`, so the game is not offered again. */
export const removeManifest = (
  dir: string,
  appID: number
): Effect.Effect<void> =>
  readManifest(dir).pipe(
    Effect.flatMap((game) =>
      game?.appID === appID
        ? Effect.promise(() =>
            fsp.rm(join(dir, MANIFEST_FILE), { force: true }).catch(() => {})
          )
        : Effect.void
    )
  );

const scanDirectory = (
  dir: string,
  depth: number
): Effect.Effect<FoundManifest[]> =>
  Effect.gen(function* () {
    const entries = yield* Effect.promise(() =>
      fsp.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => [])
    ).pipe(readLimit.withPermits(1));
    const found: FoundManifest[] = [];
    if (entries.some((entry) => entry.name === MANIFEST_FILE)) {
      const game = yield* readManifest(dir);
      if (game) found.push({ path: dir, game });
      // A game folder holds no other games, unless a game was installed
      // straight into the scan root.
      if (depth > 0) return found;
    }
    if (depth >= MAX_SCAN_DEPTH) return found;
    const nested = yield* Effect.forEach(
      entries.filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !SKIPPED_DIRS.has(entry.name)
      ),
      (entry) => scanDirectory(join(dir, entry.name), depth + 1),
      { concurrency: 'unbounded' }
    );
    return [...found, ...nested.flat()];
  });

/** Game folders with a valid manifest at or below `roots`, deduplicated. */
export const findManifests = (
  roots: readonly string[]
): Effect.Effect<FoundManifest[]> =>
  Effect.forEach(
    new Set(roots.map((root) => resolve(root))),
    (root) => scanDirectory(root, 0),
    { concurrency: 'unbounded' }
  ).pipe(
    Effect.map((results) => {
      const unique = new Map<string, FoundManifest>();
      for (const found of results.flat()) {
        unique.set(normalizeDeletePath(found.path), found);
      }
      return [...unique.values()];
    })
  );
