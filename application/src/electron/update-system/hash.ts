import { Worker } from 'node:worker_threads';
import { FileSystemError } from '@ogi-sdk/errors';
import { Effect } from 'effect';

const workerSource = `
  const { createHash } = require('node:crypto');
  const { createReadStream } = require('node:fs');
  const { parentPort } = require('node:worker_threads');
  const { crc32 } = require('node:zlib');

  const digestFile = (path) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let checksum = 0;
    let size = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      checksum = crc32(chunk, checksum);
      size += chunk.byteLength;
    });
    stream.once('error', reject);
    stream.once('end', () =>
      resolve({ sha256: hash.digest('hex'), crc32: checksum, size })
    );
  });

  parentPort.on('message', ({ id, paths }) => {
    Promise.all(paths.map(digestFile))
      .then((digests) => parentPort.postMessage({ id, digests }))
      .catch((error) => parentPort.postMessage({ id, error: String(error) }));
  });
`;

export interface FileDigest {
  readonly sha256: string;
  readonly crc32: number;
  readonly size: number;
}

interface WorkerReply {
  readonly id: number;
  readonly digests?: FileDigest[];
  readonly error?: string;
}

/* One long-lived worker serves all hashing; it idles between batches and is
   released once no requests remain in flight. */
let worker: Worker | undefined;
let nextRequestId = 0;
let inFlight = 0;
const pending = new Map<
  number,
  { resolve: (digests: FileDigest[]) => void; reject: (error: Error) => void }
>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const spawned = new Worker(workerSource, { eval: true });
  spawned.unref();
  spawned.on('message', (message: WorkerReply) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.digests) request.resolve(message.digests);
    else request.reject(new Error(message.error ?? 'Hash worker failed'));
  });
  spawned.on('error', (cause) => {
    for (const request of pending.values()) request.reject(cause);
    pending.clear();
    void spawned.terminate();
    if (worker === spawned) worker = undefined;
  });
  worker = spawned;
  return spawned;
}

function releaseWorkerIfIdle(): void {
  if (inFlight === 0 && worker) {
    void worker.terminate();
    worker = undefined;
  }
}

export function digestFiles(
  paths: readonly string[]
): Effect.Effect<readonly FileDigest[], FileSystemError> {
  if (paths.length === 0) return Effect.succeed([]);
  return Effect.tryPromise({
    try: () => {
      const id = nextRequestId++;
      inFlight += 1;
      return new Promise<FileDigest[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ensureWorker().postMessage({ id, paths });
      }).finally(() => {
        inFlight -= 1;
        releaseWorkerIfIdle();
      });
    },
    catch: (cause) =>
      new FileSystemError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

export function digestFile(
  path: string
): Effect.Effect<FileDigest, FileSystemError> {
  return digestFiles([path]).pipe(Effect.map((digests) => digests[0]));
}

export function hashFiles(
  paths: readonly string[]
): Effect.Effect<readonly string[], FileSystemError> {
  return digestFiles(paths).pipe(
    Effect.map((digests) => digests.map((digest) => digest.sha256))
  );
}

export function hashFile(path: string): Effect.Effect<string, FileSystemError> {
  return digestFile(path).pipe(Effect.map((digest) => digest.sha256));
}
