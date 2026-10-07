import { randomUUID } from 'node:crypto';
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

// Writes and removals are serialized so a removal never races a pending write,
// and writes are atomic so a drive pulled mid-write never leaves a torn manifest.
const writeLock = Effect.unsafeMakeSemaphore(1);
// Bounds directory reads across a whole scan.
const readLimit = Effect.unsafeMakeSemaphore(16);
/** A hung drive gives up its folder's manifest work so the lock is never held. */
const FOLDER_TIMEOUT = '10 seconds';
/** A slow or hung volume stops being scanned; games already found are kept. */
const ROOT_SCAN_TIMEOUT = '15 seconds';

const withFolderTimeout = (
  dir: string,
  effect: Effect.Effect<void>
): Effect.Effect<void> =>
  effect.pipe(
    Effect.timeoutTo({
      duration: FOLDER_TIMEOUT,
      onSuccess: () => Effect.void,
      onTimeout: () =>
        logger.warn(`[library] Gave up updating the manifest in ${dir}`),
    }),
    Effect.flatten
  );

const writeManifest = (info: LibraryInfo): Effect.Effect<void> => {
  const file = join(info.cwd, MANIFEST_FILE);
  const contents = `${JSON.stringify(toManifest(info), null, 2)}\n`;
  const write = Effect.tryPromise(async () => {
    const stat = await fsp.stat(info.cwd).catch(() => null);
    if (!stat?.isDirectory()) return;
    const existing = await fsp.readFile(file, 'utf8').catch(() => null);
    if (existing === contents) return;
    // Unpredictable and exclusively created, so a planted symlink is never
    // followed; rename replaces a symlink at `file` instead of writing through.
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fsp.writeFile(temporary, contents, { flag: 'wx' });
    await fsp.rename(temporary, file).catch(async (error) => {
      await fsp.rm(temporary, { force: true });
      throw error;
    });
  }).pipe(
    Effect.catchAll((error) =>
      logger.warn(`[library] Could not write ${file}`, error)
    )
  );
  return withFolderTimeout(info.cwd, write);
};

const removeOwnedManifest = (dir: string, appID: number): Effect.Effect<void> =>
  withFolderTimeout(
    dir,
    readManifest(dir).pipe(
      Effect.flatMap((game) =>
        game?.appID === appID
          ? Effect.promise(() =>
              fsp.rm(join(dir, MANIFEST_FILE), { force: true }).catch(() => {})
            )
          : Effect.void
      )
    )
  );

/**
 * Mirrors games into their folders (only `appID` and the games sharing its
 * folder when given). The library is loaded under the lock so a game removed
 * meanwhile is never written back. A folder shared with another game, home,
 * or a filesystem root never holds a manifest, so one written before the
 * folder became shared is removed.
 */
export const writeManifests = (
  loadGames: Effect.Effect<readonly LibraryInfo[], unknown>,
  appID?: number
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const games = yield* loadGames;
    const target = games.find((game) => game.appID === appID);
    const candidates = games.filter(
      (game) =>
        isAbsolute(game.cwd) &&
        (appID === undefined ||
          game === target ||
          (target !== undefined &&
            sharesDirectoryWithOtherGames(game.appID, game.cwd, [target])))
    );
    yield* Effect.forEach(
      candidates,
      (game) =>
        [homedir(), filesystemRoot()].some(
          (path) => normalizeDeletePath(path) === normalizeDeletePath(game.cwd)
        ) || sharesDirectoryWithOtherGames(game.appID, game.cwd, games)
          ? removeOwnedManifest(game.cwd, game.appID)
          : writeManifest(game),
      { concurrency: 4, discard: true }
    );
  }).pipe(
    Effect.catchAll((error) =>
      logger.warn('[library] Could not write game manifests', error)
    ),
    writeLock.withPermits(1)
  );

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

/**
 * Drops the manifest in `dir` if it belongs to `appID`, so the game is not
 * offered again. Call after the library entry is gone; queued writes then
 * skip it.
 */
export const removeManifest = (
  dir: string,
  appID: number
): Effect.Effect<void> =>
  removeOwnedManifest(dir, appID).pipe(writeLock.withPermits(1));

/** Pushes each game folder into `found` as soon as it is read. */
const scanDirectory = (
  dir: string,
  depth: number,
  found: FoundManifest[]
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const entries = yield* Effect.promise(() =>
      fsp.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => [])
    ).pipe(readLimit.withPermits(1));
    if (entries.some((entry) => entry.name === MANIFEST_FILE)) {
      const game = yield* readManifest(dir);
      if (game) found.push({ path: dir, game });
      // A game folder holds no other games, unless a game was installed
      // straight into the scan root.
      if (depth > 0) return;
    }
    if (depth >= MAX_SCAN_DEPTH) return;
    yield* Effect.forEach(
      entries.filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !SKIPPED_DIRS.has(entry.name)
      ),
      (entry) => scanDirectory(join(dir, entry.name), depth + 1, found),
      { concurrency: 'unbounded', discard: true }
    );
  });

/** Game folders with a valid manifest at or below `roots`, deduplicated. */
export const findManifests = (
  roots: readonly string[]
): Effect.Effect<FoundManifest[]> => {
  const found: FoundManifest[] = [];
  return Effect.forEach(
    new Set(roots.map((root) => resolve(root))),
    (root) =>
      scanDirectory(root, 0, found).pipe(
        Effect.timeoutTo({
          duration: ROOT_SCAN_TIMEOUT,
          onSuccess: () => Effect.void,
          onTimeout: () =>
            logger.warn(`[library] Stopped scanning ${root} for games`),
        }),
        Effect.flatten
      ),
    { concurrency: 'unbounded', discard: true }
  ).pipe(
    Effect.map(() => {
      const unique = new Map<string, FoundManifest>();
      for (const entry of found) {
        unique.set(normalizeDeletePath(entry.path), entry);
      }
      return [...unique.values()];
    })
  );
};
