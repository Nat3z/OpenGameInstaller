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
  if (/\.rar$/i.test(basename(trimmed))) {
    return Effect.succeed<string | null>(trimmed);
  }
  const fromMeta = filesMeta?.find((file) => /\.rar$/i.test(file.name));
  return fsEffect(
    electronRpc.setup.findArchive(trimmed, 'rar'),
    'Failed to inspect the downloaded directory.',
    trimmed
  ).pipe(
    Effect.map(
      (rar) => rar ?? (fromMeta ? `${trimmed}/${fromMeta.name}` : null)
    ),
    Effect.catchAll(() =>
      Effect.succeed(fromMeta ? `${trimmed}/${fromMeta.name}` : null)
    )
  );
}

/** Descends through single-child directories; falls back to `startDir` on error. */
export function drillDownSingleDirectories(startDir: string) {
  return fsEffect(
    electronRpc.setup.resolveContentRoot(startDir),
    'Failed to inspect extraction output.',
    startDir
  ).pipe(
    Effect.tapError((error) =>
      logger.error('Failed to traverse directories from:', startDir, error)
    ),
    Effect.catchAll(() => Effect.succeed(startDir))
  );
}

/** Extracts the archive (which is deleted afterwards) and returns the content root. */
function extractArchive(params: {
  archivePath: string;
  outputDir: string;
  downloadId: string;
  kind: 'RAR' | 'ZIP';
}) {
  return logger
    .info(
      `Extracting ${params.kind} file:`,
      params.archivePath,
      'to',
      params.outputDir
    )
    .pipe(
      Effect.zipRight(
        fsEffect(
          electronRpc.setup.extractArchive({
            archivePath: params.archivePath,
            outputDir: params.outputDir,
            downloadId: params.downloadId,
          }),
          `Failed to extract ${params.kind} file.`,
          params.archivePath
        )
      )
    );
}

export function unrarAndReturnOutputDir(params: {
  rarFilePath: string;
  outputBaseDir: string;
  downloadId: string;
}) {
  return extractArchive({
    archivePath: params.rarFilePath,
    outputDir: params.outputBaseDir,
    downloadId: params.downloadId,
    kind: 'RAR',
  });
}

export function unzipAndReturnOutputDir(params: {
  zipFilePath: string;
  outputDirBase: string;
  downloadId: string;
}) {
  return extractArchive({
    archivePath: params.zipFilePath,
    outputDir: params.outputDirBase,
    downloadId: params.downloadId,
    kind: 'ZIP',
  }).pipe(Effect.map((outputDir) => `${outputDir}/`));
}
