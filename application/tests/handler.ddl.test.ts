import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import { Effect } from 'effect';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';

class MockAxiosError extends Error {
  constructor(
    public response?: {
      status: number;
      headers: Record<string, string>;
    }
  ) {
    super('mock axios error');
  }
}

class MockBrowserWindow {}

const get = mock(() =>
  Promise.resolve({
    status: 200,
    headers: {
      'content-length': '7',
      'ogi-parallel-limit': '1',
    },
    data: Readable.from([Buffer.from('payload')]),
  })
);
const head = mock(() => Promise.reject(new Error('unused')));

mock.module('axios', () => ({
  default: { get, head },
  AxiosError: MockAxiosError,
}));
mock.module('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  ipcMain: {
    handle: mock(() => {}),
    handleOnce: mock(() => {}),
    removeHandler: mock(() => {}),
  },
}));
mock.module('@/electron/lib/online.js', () => ({
  getEffectiveOnlineState: () => ({ effectiveOnline: true }),
}));
mock.module('@/electron/main.js', () => ({
  sendNotification: mock(() => {}),
}));
mock.module('@/electron/manager/manager.config.js', () => ({
  getStoredValue: () => Effect.succeed(8),
  refreshCached: () => Effect.void,
}));
mock.module('@/electron/manager/manager.queue.js', () => ({
  DOWNLOAD_QUEUE: {
    enqueue: () => ({
      wait: () => Effect.succeed('ready'),
      finish: () => {},
      cancelHandler: () => {},
    }),
  },
}));
mock.module('@/lib/download-handshake.js', () => ({
  clearDownloadHandshake: mock(() => {}),
  registerDownloadHandshake: mock(() => {}),
  updateDownloadHandshake: mock(() => {}),
  waitForDownloadHandshake: mock(() =>
    Promise.resolve({ status: 'downloading' })
  ),
}));

let Download: typeof import('../src/electron/handlers/handler.ddl.js').Download;
const testDirectories: string[] = [];

beforeAll(async () => {
  ({ Download } = await import('../src/electron/handlers/handler.ddl.js'));
});

beforeEach(() => {
  get.mockClear();
  head.mockClear();
  get.mockImplementation(() =>
    Promise.resolve({
      status: 200,
      headers: {
        'content-length': '7',
        'ogi-parallel-limit': '1',
      },
      data: Readable.from([Buffer.from('payload')]),
    })
  );
  head.mockImplementation(() => Promise.reject(new Error('unused')));
});

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('OGI-Parallel-Limit response handling', () => {
  test('discovers a GET-only limit before starting chunk fan-out', async () => {
    head.mockImplementationOnce(() =>
      Promise.resolve({
        status: 200,
        headers: {
          'content-length': String(101 * 1024 * 1024),
          'accept-ranges': 'bytes',
        },
      })
    );
    get.mockImplementationOnce(() =>
      Promise.resolve({
        status: 206,
        headers: { 'ogi-parallel-limit': '1' },
        data: Readable.from([Buffer.from('x')]),
      })
    );
    const job = {
      link: 'https://example.test/file',
      path: join(tmpdir(), 'unused-download.bin'),
    };
    const download = new Download(
      {
        isDestroyed: () => false,
        webContents: { send: () => {} },
      } as never,
      [job]
    );

    const info = await Effect.runPromise(
      (
        download as unknown as {
          shouldUseParallelDownloadForPart(
            currentJob: typeof job
          ): Effect.Effect<{
            useParallel: boolean;
            parallelLimit?: number;
          }>;
        }
      ).shouldUseParallelDownloadForPart(job)
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(info.parallelLimit).toBe(1);
    expect(info.useParallel).toBe(false);
  });

  test('retains a limit returned by the live download response', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-parallel-limit-'));
    testDirectories.push(directory);
    const path = join(directory, 'download.bin');
    const job = { link: 'https://example.test/file', path };
    const download = new Download(
      {
        isDestroyed: () => false,
        webContents: { send: () => {} },
      } as never,
      [job]
    );
    download.status = 'downloading';

    await Effect.runPromise(
      (
        download as unknown as {
          _executeDownloadPart(currentJob: typeof job): Effect.Effect<void>;
        }
      )._executeDownloadPart(job)
    );

    expect(readFileSync(path, 'utf8')).toBe('payload');
    expect(
      (download as unknown as { parallelLimit?: number }).parallelLimit
    ).toBe(1);
  });

  test('retains a changed limit from a failed response and releases the file', async () => {
    get.mockImplementationOnce(() =>
      Promise.reject(
        new MockAxiosError({
          status: 429,
          headers: { 'ogi-parallel-limit': '2' },
        })
      )
    );
    const directory = mkdtempSync(join(tmpdir(), 'ogi-failed-limit-'));
    testDirectories.push(directory);
    const path = join(directory, 'download.bin');
    const job = { link: 'https://example.test/file', path };
    const download = new Download(
      {
        isDestroyed: () => false,
        webContents: { send: () => {} },
      } as never,
      [job]
    );
    download.status = 'downloading';

    const result = await Effect.runPromise(
      Effect.either(
        (
          download as unknown as {
            _executeDownloadPart(
              currentJob: typeof job
            ): Effect.Effect<void, unknown>;
          }
        )._executeDownloadPart(job)
      )
    );

    expect(result._tag).toBe('Left');
    expect(
      (download as unknown as { parallelLimit?: number }).parallelLimit
    ).toBe(2);
    expect(
      (download as unknown as { fileStream?: unknown }).fileStream
    ).toBeUndefined();
  });

  test('repartitions cleanly when a failed attempt learns a stricter limit', async () => {
    head.mockImplementationOnce(() =>
      Promise.resolve({
        status: 200,
        headers: {
          'content-length': String(101 * 1024 * 1024),
          'accept-ranges': 'bytes',
          'ogi-parallel-limit': '4',
        },
      })
    );
    get.mockImplementationOnce(() =>
      Promise.resolve({
        status: 206,
        headers: { 'ogi-parallel-limit': '4' },
        data: Readable.from([Buffer.from('x')]),
      })
    );
    const directory = mkdtempSync(join(tmpdir(), 'ogi-repartition-'));
    testDirectories.push(directory);
    const path = join(directory, 'download.bin');
    const job = { link: 'https://example.test/file', path };
    const download = new Download(
      {
        isDestroyed: () => false,
        webContents: { send: () => {} },
      } as never,
      [job]
    );
    const part = {
      index: 0,
      job,
      status: 'downloading' as
        | 'pending'
        | 'downloading'
        | 'completed'
        | 'failed'
        | 'merging',
      downloadedBytes: 0,
      totalBytes: 0,
      abortController: new AbortController(),
      useChunks: false,
      chunks: [],
      chunkJobPath: '',
      parallelLimit: undefined as number | undefined,
      effectiveChunkCount: undefined as number | undefined,
    };
    let attempt = 0;
    let staleChunksFound = true;
    const internals = download as unknown as {
      executeParallelDownloadForPart(
        currentPart: typeof part
      ): Effect.Effect<void, { message: string }>;
      downloadPartWithState(
        currentPart: typeof part,
        retries: number
      ): Effect.Effect<void, { message: string }>;
    };
    internals.executeParallelDownloadForPart = (currentPart) =>
      Effect.gen(function* () {
        attempt++;
        if (attempt === 1) {
          for (let index = 0; index < 4; index++) {
            writeFileSync(`${path}.chunk${index}`, 'old-layout');
          }
          currentPart.parallelLimit = 2;
          return yield* Effect.fail({ message: 'simulated failure' });
        }
        staleChunksFound = Array.from({ length: 4 }, (_, index) =>
          existsSync(`${path}.chunk${index}`)
        ).some(Boolean);
      });
    download.status = 'downloading';

    await Effect.runPromise(internals.downloadPartWithState(part, 2));

    expect(attempt).toBe(2);
    expect(part.effectiveChunkCount).toBe(2);
    expect(staleChunksFound).toBe(false);
    expect(part.status).toBe('completed');
  });
});

describe('parallel chunk merging', () => {
  test('waits for a part that is still merging before resolving', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-wait-merge-'));
    testDirectories.push(directory);
    const job = {
      link: 'https://example.test/file',
      path: join(directory, 'download.bin'),
      headers: { 'OGI-Parallel-Limit': '1' },
    };
    const download = new Download(
      {
        isDestroyed: () => false,
        webContents: { send: () => {} },
      } as never,
      [job]
    );
    const part = {
      index: 0,
      job,
      status: 'pending' as
        | 'pending'
        | 'downloading'
        | 'completed'
        | 'failed'
        | 'merging',
      downloadedBytes: 0,
      totalBytes: 0,
      abortController: new AbortController(),
      useChunks: false,
      chunks: [],
      chunkJobPath: '',
      parallelLimit: 1,
    };
    const internals = download as unknown as {
      parts: Array<typeof part>;
      downloadPartWithState(currentPart: typeof part): Effect.Effect<void>;
      runParallelParts(): Effect.Effect<void>;
    };
    internals.parts = [part];
    internals.downloadPartWithState = (currentPart) =>
      Effect.sync(() => {
        currentPart.status = 'merging';
      }).pipe(
        Effect.zipRight(Effect.sleep('250 millis')),
        Effect.tap(() =>
          Effect.sync(() => {
            currentPart.status = 'completed';
          })
        )
      );
    download.status = 'downloading';

    const startedAt = Date.now();
    await Effect.runPromise(internals.runParallelParts());

    expect(part.status).toBe('completed');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  });

  test('rejects a corrupted chunk instead of completing the merge', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ogi-corrupt-merge-'));
    testDirectories.push(directory);
    const path = join(directory, 'download.bin');
    writeFileSync(`${path}.chunk0`, 'too-long');
    writeFileSync(`${path}.chunk1`, 'def');
    const job = { link: 'https://example.test/file', path };
    const download = new Download(
      {
        isDestroyed: () => false,
        webContents: { send: () => {} },
      } as never,
      [job]
    );
    const part = {
      index: 0,
      job,
      status: 'merging' as const,
      downloadedBytes: 11,
      totalBytes: 6,
      abortController: new AbortController(),
      useChunks: true,
      chunks: [
        {
          index: 0,
          startByte: 0,
          endByte: 2,
          currentBytes: 8,
          abortController: new AbortController(),
          completed: true,
        },
        {
          index: 1,
          startByte: 3,
          endByte: 5,
          currentBytes: 3,
          abortController: new AbortController(),
          completed: true,
        },
      ],
      chunkJobPath: path,
      effectiveChunkCount: 2,
    };

    const result = await Effect.runPromise(
      Effect.either(
        (
          download as unknown as {
            mergeChunkFilesForPart(
              currentPart: typeof part
            ): Effect.Effect<void, unknown>;
          }
        ).mergeChunkFilesForPart(part)
      )
    );

    expect(result._tag).toBe('Left');
  });
});
