import { FileSystemError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { basename } from '@/frontend/lib/core/fs';
import { electronRpc } from '@/frontend/lib/electron-rpc';

const logger = createLogger(LOGGER_PREFIXES.frontend);

const fsEffect = <A>(
  operation: Effect.Effect<A, unknown>,
  message: string,
  path?: string
): Effect.Effect<A, FileSystemError> =>
  operation.pipe(
    Effect.mapError((cause) => new FileSystemError({ message, path, cause }))
  );

/** Resolves a RAR path from a direct file, downloaded directory, or file metadata. */
export function resolveRarArchivePath(
  downloadPath: string,
  filesMeta?: { name: string }[]
) {
  const trimmed = downloadPath.replace(/[\/\\]+$/, '');
  const base = basename(trimmed);
  if (/\.rar$/i.test(base)) {
    return Effect.succeed<string | null>(trimmed);
  }

  return fsEffect(
    electronRpc.fs.getFilesInDir(trimmed),
    'Failed to inspect the downloaded directory.',
    trimmed
  ).pipe(
    Effect.map((files) => {
      const rar = files.find((file) => /\.rar$/i.test(file));
      if (rar) return `${trimmed}/${rar}`;
      const fromMeta = filesMeta?.find((file) => /\.rar$/i.test(file.name));
      return fromMeta ? `${trimmed}/${fromMeta.name}` : null;
    }),
    Effect.catchAll(() => {
      const fromMeta = filesMeta?.find((file) => /\.rar$/i.test(file.name));
      return Effect.succeed(fromMeta ? `${trimmed}/${fromMeta.name}` : null);
    })
  );
}

export function drillDownSingleDirectories(
  startDir: string,
  maxDepth: number = 10
) {
  return Effect.gen(function* () {
    let currentDir = startDir;
    let filesInDir = yield* fsEffect(
      electronRpc.fs.getFilesInDir(currentDir),
      'Failed to inspect extraction output.',
      currentDir
    );

    for (let depth = 0; filesInDir.length === 1 && depth < maxDepth; depth++) {
      const nextPath = `${currentDir}/${filesInDir[0]}`;
      const stat = yield* Effect.try({
        try: () => window.electronAPI.fs.stat(nextPath),
        catch: (cause) =>
          new FileSystemError({
            message: 'Failed to inspect extracted path.',
            path: nextPath,
            cause,
          }),
      });
      if (!stat?.isDirectory) break;
      currentDir = nextPath;
      filesInDir = yield* fsEffect(
        electronRpc.fs.getFilesInDir(currentDir),
        'Failed to inspect extraction output.',
        currentDir
      );
    }

    return currentDir;
  }).pipe(
    Effect.tapError((error) =>
      logger.error('Failed to traverse directories from:', startDir, error)
    ),
    Effect.catchAll(() => Effect.succeed(startDir))
  );
}

export function unrarAndReturnOutputDir(params: {
  rarFilePath: string;
  outputBaseDir: string;
  downloadId: string;
}) {
  const { rarFilePath, outputBaseDir, downloadId } = params;
  return Effect.gen(function* () {
    yield* logger.info(
      'Extracting RAR file:',
      rarFilePath,
      'to',
      outputBaseDir
    );
    const extractedDir = yield* fsEffect(
      electronRpc.fs.unrar({
        outputDir: outputBaseDir,
        rarFilePath,
        downloadId,
      }),
      'Failed to extract RAR file.',
      rarFilePath
    );
    yield* Effect.try({
      try: () => window.electronAPI.fs.delete(rarFilePath),
      catch: (cause) =>
        new FileSystemError({
          message: 'Failed to delete extracted RAR file.',
          path: rarFilePath,
          cause,
        }),
    }).pipe(
      Effect.tapError((error) =>
        logger.error(error.message, rarFilePath, error.cause)
      ),
      Effect.ignore
    );
    return extractedDir;
  });
}

export function unzipAndReturnOutputDir(params: {
  zipFilePath: string;
  outputDirBase: string;
  downloadId: string;
}) {
  const { zipFilePath, outputDirBase, downloadId } = params;
  return Effect.gen(function* () {
    yield* logger.info('Extracting ZIP file:', zipFilePath);
    const queriedOutput = yield* fsEffect(
      electronRpc.fs.unzip({
        zipFilePath,
        outputDir: outputDirBase,
        downloadId,
      }),
      'Failed to extract ZIP file.',
      zipFilePath
    );
    if (!queriedOutput) return undefined;

    const outputDir = `${yield* drillDownSingleDirectories(queriedOutput, 10)}/`;
    yield* Effect.try({
      try: () => window.electronAPI.fs.delete(zipFilePath),
      catch: (cause) =>
        new FileSystemError({
          message: 'Failed to delete extracted ZIP file.',
          path: zipFilePath,
          cause,
        }),
    }).pipe(
      Effect.tapError((error) =>
        logger.error(error.message, zipFilePath, error.cause)
      ),
      Effect.ignore
    );
    return outputDir;
  });
}
