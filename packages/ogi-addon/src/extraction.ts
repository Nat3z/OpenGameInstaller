import { spawn, type ChildProcess } from 'child_process';
import { FileSystemError, PlatformError } from '@ogi/errors';
import { Effect } from 'effect';

const sevenZipPath = 'C:\\Program Files\\7-Zip\\7z.exe';
type ExtractionError = FileSystemError | PlatformError;

const spawnProcess = (
  command: string,
  args: readonly string[],
  options?: Parameters<typeof spawn>[2]
): Effect.Effect<ChildProcess, FileSystemError> =>
  Effect.try({
    try: () => options
      ? spawn(command, [...args], options)
      : spawn(command, [...args]),
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
      resume(Effect.fail(new FileSystemError({ message: `${errorMessage}: ${cause.message}`, cause })));
    };
    const onClose = (code: number | null): void => {
      cleanup();
      resume(code === 0
        ? Effect.void
        : Effect.fail(new FileSystemError({ message: `${errorMessage} (exit code ${String(code)})` })));
    };
    const cleanup = (): void => {
      child.off('error', onError);
      child.off('close', onClose);
    };
    child.once('error', onError);
    child.once('close', onClose);
    return Effect.sync(cleanup);
  });

const detectUnrarType = (): Effect.Effect<'unrar-free' | 'unrar-nonfree' | 'unknown', FileSystemError> =>
  Effect.gen(function* () {
    const child = yield* spawnProcess('unrar', []);
    let output = '';
    child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
    yield* waitForChildProcess(child, 'Unable to detect unrar implementation').pipe(
      Effect.catchAll(() => Effect.void)
    );
    return output.includes('unrar-free')
      ? 'unrar-free'
      : output.includes('unrar-nonfree')
        ? 'unrar-nonfree'
        : 'unknown';
  });

export const extraction = (
  filePath: string,
  outputDir: string
): Effect.Effect<void, ExtractionError> =>
  Effect.gen(function* () {
    if (process.platform === 'win32') {
      const child = yield* spawnProcess(sevenZipPath, ['x', filePath, '-o', outputDir]);
      return yield* waitForChildProcess(child, 'Failed to extract file');
    }

    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      return yield* Effect.fail(new PlatformError({
        message: `Unsupported extraction platform: ${process.platform}`,
        platform: process.platform,
      }));
    }

    const lowerPath = filePath.toLowerCase();
    if (lowerPath.endsWith('.zip')) {
      const child = yield* spawnProcess('unzip', ['-o', filePath, '-d', outputDir], {
        env: { ...process.env, UNZIP_DISABLE_ZIPBOMB_DETECTION: 'TRUE' },
      });
      return yield* waitForChildProcess(child, 'Failed to unzip file');
    }

    if (lowerPath.endsWith('.rar')) {
      const type = yield* detectUnrarType();
      const args = type === 'unrar-free'
        ? ['-f', '-x', filePath, outputDir]
        : type === 'unrar-nonfree'
          ? ['-o', filePath, '-d', outputDir]
          : undefined;
      if (!args) {
        return yield* Effect.fail(new FileSystemError({ message: 'Unknown unrar implementation', path: filePath }));
      }
      const child = yield* spawnProcess('unrar', args);
      return yield* waitForChildProcess(child, 'Failed to unrar file');
    }

    return yield* Effect.fail(new FileSystemError({
      message: `Unsupported archive type: ${filePath}`,
      path: filePath,
    }));
  });
