import { type ChildProcess, spawn } from 'node:child_process';
import * as fsAsync from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystemError, PlatformError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import {
  detectUnrarTypeFromOutput,
  isSupportedArchivePath,
  parseSevenZipTotal,
  parseUnrarFreeTotal,
  parseUnrarNonFreeTotal,
  parseZipInfoTotal,
  type UnrarType,
} from './extraction-progress';

const sevenZipPath = 'C:\\Program Files\\7-Zip\\7z.exe';
const progressPollIntervalMs = 150;
type ExtractionError = FileSystemError | PlatformError;

export type ExtractionProgress = number | null;
export type ExtractionProgressCallback = (progress: ExtractionProgress) => void;

const spawnProcess = (
  command: string,
  args: readonly string[],
  options?: Parameters<typeof spawn>[2]
): Effect.Effect<ChildProcess, FileSystemError> =>
  Effect.try({
    try: () =>
      options ? spawn(command, [...args], options) : spawn(command, [...args]),
    catch: (cause) =>
      new FileSystemError({
        message: `Unable to start ${command}: ${String(cause)}`,
        cause,
      }),
  });

const waitForChildProcess = (
  child: ChildProcess,
  errorMessage: string
): Effect.Effect<void, FileSystemError> =>
  Effect.async((resume) => {
    const onError = (cause: Error): void => {
      cleanup();
      resume(
        Effect.fail(
          new FileSystemError({
            message: `${errorMessage}: ${cause.message}`,
            cause,
          })
        )
      );
    };
    const onClose = (code: number | null): void => {
      cleanup();
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(
              new FileSystemError({
                message: `${errorMessage} (exit code ${String(code)})`,
              })
            )
      );
    };
    const cleanup = (): void => {
      child.off('error', onError);
      child.off('close', onClose);
    };
    child.once('error', onError);
    child.once('close', onClose);
    return Effect.sync(() => {
      cleanup();
      if (child.exitCode === null && !child.killed) child.kill();
    });
  });

const collectProcessOutput = (
  command: string,
  args: readonly string[],
  options?: Parameters<typeof spawn>[2],
  allowNonZeroExit = false
): Effect.Effect<string, FileSystemError> =>
  Effect.gen(function* () {
    const child = yield* spawnProcess(command, args, options);
    let output = '';
    const collectOutput = (data: Buffer): void => {
      output += data.toString();
    };
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        child.stdout?.on('data', collectOutput);
        child.stderr?.on('data', collectOutput);
      }),
      () => {
        const wait = waitForChildProcess(
          child,
          `Failed to inspect ${command} output`
        );
        return allowNonZeroExit
          ? wait.pipe(Effect.catchAll(() => Effect.void))
          : wait;
      },
      () =>
        Effect.sync(() => {
          child.stdout?.off('data', collectOutput);
          child.stderr?.off('data', collectOutput);
        })
    );
    return output;
  });

const detectUnrarType = (): Effect.Effect<UnrarType, FileSystemError> =>
  collectProcessOutput('unrar', [], undefined, true).pipe(
    Effect.catchAll(() => Effect.succeed('')),
    Effect.map(detectUnrarTypeFromOutput)
  );

const getArchiveSize = (
  filePath: string,
  unrarType?: UnrarType
): Effect.Effect<number | undefined> => {
  if (process.platform === 'win32') {
    return collectProcessOutput(sevenZipPath, ['l', '-slt', filePath]).pipe(
      Effect.map(parseSevenZipTotal),
      Effect.catchAll(() => Effect.succeed(undefined))
    );
  }

  if (filePath.toLowerCase().endsWith('.zip')) {
    return collectProcessOutput('unzip', ['-Z', '-t', filePath], {
      env: { ...process.env, LC_ALL: 'C' },
    }).pipe(
      Effect.map(parseZipInfoTotal),
      Effect.catchAll(() => Effect.succeed(undefined))
    );
  }

  if (unrarType === 'unrar-free') {
    return collectProcessOutput('unrar', ['l', filePath], {
      env: { ...process.env, LC_ALL: 'C' },
    }).pipe(
      Effect.map(parseUnrarFreeTotal),
      Effect.catchAll(() => Effect.succeed(undefined))
    );
  }

  if (unrarType === 'unrar-nonfree') {
    return collectProcessOutput('unrar', ['lt', '-c-', filePath], {
      env: { ...process.env, LC_ALL: 'C' },
    }).pipe(
      Effect.map(parseUnrarNonFreeTotal),
      Effect.catchAll(() => Effect.succeed(undefined))
    );
  }

  return Effect.succeed(undefined);
};

const getRegularFileBytes = async (directory: string): Promise<number> => {
  let total = 0;
  const entries = await fsAsync.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await getRegularFileBytes(entryPath);
    } else if (entry.isFile()) {
      total += (await fsAsync.stat(entryPath)).size;
    }
  }
  return total;
};

const mergeDirectory = async (
  sourceDir: string,
  destinationDir: string
): Promise<void> => {
  const destinationStat = await fsAsync
    .lstat(destinationDir)
    .catch(() => undefined);
  if (destinationStat && !destinationStat.isDirectory()) {
    await fsAsync.rm(destinationDir, { recursive: true, force: true });
  }
  await fsAsync.mkdir(destinationDir, { recursive: true });
  const entries = await fsAsync.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await mergeDirectory(source, destination);
      await fsAsync.rm(source, { recursive: true, force: true });
      continue;
    }
    await fsAsync.rm(destination, { recursive: true, force: true });
    await fsAsync.rename(source, destination);
  }
};

const reportProgress = (
  callback: ExtractionProgressCallback | undefined,
  progress: ExtractionProgress
): void => {
  try {
    callback?.(progress);
  } catch {
    // Progress observers must not be able to fail extraction.
  }
};

export const extraction = (
  filePath: string,
  outputDir: string,
  onProgress?: ExtractionProgressCallback
): Effect.Effect<void, ExtractionError> =>
  Effect.gen(function* () {
    if (
      process.platform !== 'win32' &&
      process.platform !== 'linux' &&
      process.platform !== 'darwin'
    ) {
      return yield* Effect.fail(
        new PlatformError({
          message: `Unsupported extraction platform: ${process.platform}`,
          platform: process.platform,
        })
      );
    }

    const lowerPath = filePath.toLowerCase();
    if (!isSupportedArchivePath(process.platform, lowerPath)) {
      return yield* Effect.fail(
        new FileSystemError({
          message: `Unsupported archive type: ${filePath}`,
          path: filePath,
        })
      );
    }

    const unrarType =
      process.platform !== 'win32' && lowerPath.endsWith('.rar')
        ? yield* detectUnrarType()
        : undefined;
    if (
      process.platform !== 'win32' &&
      lowerPath.endsWith('.rar') &&
      unrarType === 'unknown'
    ) {
      return yield* Effect.fail(
        new FileSystemError({
          message: 'Unknown unrar implementation',
          path: filePath,
        })
      );
    }

    yield* Effect.tryPromise({
      try: () => fsAsync.mkdir(outputDir, { recursive: true }),
      catch: (cause) =>
        new FileSystemError({
          message: `Unable to create extraction directory: ${String(cause)}`,
          path: outputDir,
          cause,
        }),
    });
    const stagingDir = yield* Effect.tryPromise({
      try: () => fsAsync.mkdtemp(join(outputDir, '.ogi-extract-')),
      catch: (cause) =>
        new FileSystemError({
          message: `Unable to create extraction staging directory: ${String(cause)}`,
          path: outputDir,
          cause,
        }),
    });

    return yield* Effect.gen(function* () {
      const totalBytes = yield* getArchiveSize(filePath, unrarType);
      reportProgress(onProgress, totalBytes === undefined ? null : 0);

      let child: ChildProcess;
      let failureMessage: string;
      if (process.platform === 'win32') {
        child = yield* spawnProcess(
          sevenZipPath,
          ['x', filePath, `-o${stagingDir}`, '-y'],
          { stdio: 'ignore' }
        );
        failureMessage = 'Failed to extract file';
      } else if (lowerPath.endsWith('.zip')) {
        child = yield* spawnProcess(
          'unzip',
          ['-o', filePath, '-d', stagingDir],
          {
            env: {
              ...process.env,
              LC_ALL: 'C',
              UNZIP_DISABLE_ZIPBOMB_DETECTION: 'TRUE',
            },
            stdio: 'ignore',
          }
        );
        failureMessage = 'Failed to unzip file';
      } else {
        const args =
          unrarType === 'unrar-free'
            ? ['-f', '-x', filePath, stagingDir]
            : ['x', '-o+', filePath, stagingDir];
        child = yield* spawnProcess('unrar', args, { stdio: 'ignore' });
        failureMessage = 'Failed to unrar file';
      }

      let measuring = false;
      let pollingStopped = false;
      let activeMeasurement: Promise<void> | undefined;
      const measure = (): void => {
        if (
          measuring ||
          pollingStopped ||
          totalBytes === undefined ||
          totalBytes <= 0
        ) {
          return;
        }
        measuring = true;
        activeMeasurement = getRegularFileBytes(stagingDir)
          .then((extractedBytes) => {
            if (!pollingStopped) {
              reportProgress(
                onProgress,
                Math.min(extractedBytes / totalBytes, 0.99)
              );
            }
          })
          .catch(() => {
            // A file can disappear between directory enumeration and stat.
          })
          .finally(() => {
            measuring = false;
            activeMeasurement = undefined;
          });
      };

      yield* Effect.acquireUseRelease(
        Effect.sync(() => setInterval(measure, progressPollIntervalMs)),
        () => waitForChildProcess(child, failureMessage),
        (interval) =>
          Effect.sync(() => {
            pollingStopped = true;
            clearInterval(interval);
          }).pipe(
            Effect.zipRight(
              Effect.promise(() => activeMeasurement ?? Promise.resolve())
            )
          )
      );
      yield* Effect.tryPromise({
        try: () => mergeDirectory(stagingDir, outputDir),
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to move extracted files: ${String(cause)}`,
            path: outputDir,
            cause,
          }),
      });
      reportProgress(onProgress, 1);
    }).pipe(
      Effect.ensuring(
        Effect.promise(() =>
          fsAsync.rm(stagingDir, { recursive: true, force: true })
        )
      )
    );
  });
