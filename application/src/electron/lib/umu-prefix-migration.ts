import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatError, PlatformError } from '@ogi/errors';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { Effect } from 'effect';

const migrationMarkerName = '.ogi-prefix-migration.json';
const activeStagingPaths = new Set<string>();

type PrefixMigrationState = {
  stagingPath: string;
  finalPath: string;
  promoted: boolean;
  committed: boolean;
  cancelled: boolean;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('UMU prefix migration was cancelled');
};

const copyDirectory = async (
  source: string,
  destination: string,
  signal: AbortSignal
): Promise<void> => {
  throwIfAborted(signal);
  const sourceStats = await fs.promises.lstat(source);
  await fs.promises.mkdir(destination, {
    recursive: true,
    mode: sourceStats.mode,
  });
  for (const entry of await fs.promises.readdir(source, {
    withFileTypes: true,
  })) {
    throwIfAborted(signal);
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      await fs.promises.symlink(
        await fs.promises.readlink(sourcePath),
        destinationPath
      );
    } else if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath, signal);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(sourcePath, destinationPath);
      await fs.promises.chmod(
        destinationPath,
        (await fs.promises.stat(sourcePath)).mode
      );
    } else {
      throw new Error(`Unsupported prefix entry: ${sourcePath}`);
    }
  }
  throwIfAborted(signal);
  await fs.promises.chmod(destination, sourceStats.mode);
};

const listPrefixEntries = async (
  root: string,
  signal: AbortSignal,
  current = root
): Promise<
  Map<
    string,
    { type: 'directory' | 'file' | 'symlink'; size?: number; target?: string }
  >
> => {
  const result = new Map<
    string,
    { type: 'directory' | 'file' | 'symlink'; size?: number; target?: string }
  >();
  for (const entry of await fs.promises.readdir(current, {
    withFileTypes: true,
  })) {
    throwIfAborted(signal);
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (entry.isSymbolicLink()) {
      result.set(relativePath, {
        type: 'symlink',
        target: await fs.promises.readlink(absolutePath),
      });
    } else if (entry.isDirectory()) {
      result.set(relativePath, { type: 'directory' });
      for (const [key, value] of await listPrefixEntries(
        root,
        signal,
        absolutePath
      )) {
        result.set(key, value);
      }
    } else if (entry.isFile()) {
      result.set(relativePath, {
        type: 'file',
        size: (await fs.promises.stat(absolutePath)).size,
      });
    } else {
      throw new Error(`Unsupported prefix entry: ${absolutePath}`);
    }
  }
  return result;
};

const validateCopiedPrefix = async (
  source: string,
  staging: string,
  signal: AbortSignal
): Promise<void> => {
  const sourceEntries = await listPrefixEntries(source, signal);
  const stagingEntries = await listPrefixEntries(staging, signal);
  if (sourceEntries.size === 0) throw new Error('The source prefix is empty');
  if (sourceEntries.size !== stagingEntries.size) {
    throw new Error('The staged prefix contains a different number of entries');
  }
  for (const [relativePath, expected] of sourceEntries) {
    const actual = stagingEntries.get(relativePath);
    if (!actual || actual.type !== expected.type) {
      throw new Error(`The staged prefix is missing ${relativePath}`);
    }
    if (expected.type === 'file' && actual.size !== expected.size) {
      throw new Error(`The staged file size differs for ${relativePath}`);
    }
    if (expected.type === 'symlink' && actual.target !== expected.target) {
      throw new Error(`The staged symlink differs for ${relativePath}`);
    }
  }
};

export const resolveLegacyPrefixSource = (params: {
  steamCompatDataPath?: string;
  configuredCompatDataPath?: string;
  configuredPrefix?: string;
}): string | undefined => {
  const prefixRoot = (candidate?: string): string | undefined =>
    candidate && path.basename(candidate).toLowerCase() === 'pfx'
      ? path.dirname(candidate)
      : candidate;

  return [
    prefixRoot(params.configuredPrefix),
    prefixRoot(params.configuredCompatDataPath),
    params.steamCompatDataPath,
  ].find(
    (candidate): candidate is string =>
      candidate !== undefined && fs.existsSync(candidate)
  );
};

export const stagedPrefixMigration = (params: {
  libraryInfo: LibraryInfo;
  sourcePath?: string;
  finalPath: string;
  initialize?: (stagingPath: string, signal: AbortSignal) => Promise<void>;
  commit: (libraryInfo: LibraryInfo) => void;
}): Effect.Effect<LibraryInfo, PlatformError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const parent = path.dirname(params.finalPath);
        const basename = path.basename(params.finalPath);
        fs.mkdirSync(parent, { recursive: true });
        const stagingPrefix = `.${basename}.ogi-migrate-`;
        for (const entry of fs.readdirSync(parent)) {
          if (!entry.startsWith(stagingPrefix)) continue;
          const stagingPath = path.join(parent, entry);
          if (activeStagingPaths.has(stagingPath)) continue;
          fs.rmSync(stagingPath, { recursive: true, force: true });
        }

        if (fs.existsSync(params.finalPath)) {
          const markerPath = path.join(params.finalPath, migrationMarkerName);
          if (fs.existsSync(markerPath)) {
            params.libraryInfo.umu = {
              ...params.libraryInfo.umu!,
              winePrefixPath: params.finalPath,
            };
            params.commit(params.libraryInfo);
            fs.rmSync(markerPath, { force: true });
            return {
              stagingPath: '',
              finalPath: params.finalPath,
              promoted: true,
              committed: true,
              cancelled: false,
            };
          }
          const destinationStats = fs.lstatSync(params.finalPath);
          if (
            !destinationStats.isDirectory() ||
            fs.readdirSync(params.finalPath).length > 0
          ) {
            throw new Error(
              `UMU prefix destination already exists: ${params.finalPath}. It was not overwritten.`
            );
          }
          fs.rmdirSync(params.finalPath);
        }
        const stagingPath = fs.mkdtempSync(
          path.join(parent, `${stagingPrefix}${process.pid}-`)
        );
        activeStagingPaths.add(stagingPath);
        const state: PrefixMigrationState = {
          stagingPath,
          finalPath: params.finalPath,
          promoted: false,
          committed: false,
          cancelled: false,
        };
        return state;
      },
      catch: (cause) =>
        new PlatformError({
          message: formatError(cause),
          platform: process.platform,
        }),
    }),
    (state) =>
      Effect.tryPromise({
        try: async (signal) => {
          try {
            if (state.committed) return params.libraryInfo;
            if (params.sourcePath) {
              await copyDirectory(params.sourcePath, state.stagingPath, signal);
              await validateCopiedPrefix(
                params.sourcePath,
                state.stagingPath,
                signal
              );
            } else if (params.initialize) {
              await params.initialize(state.stagingPath, signal);
              if (fs.readdirSync(state.stagingPath).length === 0) {
                throw new Error('UMU initialized an empty Wine prefix');
              }
            } else {
              throw new Error('No source prefix or initializer was provided');
            }

            if (state.cancelled) {
              if (fs.existsSync(state.stagingPath)) {
                fs.rmSync(state.stagingPath, { recursive: true, force: true });
              }
              throw new Error('UMU prefix migration was cancelled');
            }

            fs.writeFileSync(
              path.join(state.stagingPath, migrationMarkerName),
              JSON.stringify({ appID: params.libraryInfo.appID })
            );
            fs.renameSync(state.stagingPath, state.finalPath);
            state.promoted = true;
            params.libraryInfo.umu = {
              ...params.libraryInfo.umu!,
              winePrefixPath: state.finalPath,
            };
            params.commit(params.libraryInfo);
            state.committed = true;
            try {
              fs.rmSync(path.join(state.finalPath, migrationMarkerName), {
                force: true,
              });
            } catch (cause) {
              console.warn('[umu] Could not remove migration marker', cause);
            }
            return params.libraryInfo;
          } finally {
            if (
              (signal.aborted || state.cancelled) &&
              fs.existsSync(state.stagingPath)
            ) {
              fs.rmSync(state.stagingPath, { recursive: true, force: true });
            }
          }
        },
        catch: (cause) =>
          new PlatformError({
            message: formatError(cause),
            platform: process.platform,
          }),
      }),
    (state) =>
      Effect.sync(() => {
        activeStagingPaths.delete(state.stagingPath);
        state.cancelled = !state.committed;
        if (fs.existsSync(state.stagingPath)) {
          fs.rmSync(state.stagingPath, { recursive: true, force: true });
        }
        if (
          state.promoted &&
          !state.committed &&
          fs.existsSync(state.finalPath)
        ) {
          fs.rmSync(state.finalPath, { recursive: true, force: true });
        }
      })
  );
