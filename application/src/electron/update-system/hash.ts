import { Worker } from 'node:worker_threads';
import { FileSystemError } from '@ogi-sdk/errors';
import { Effect } from 'effect';

const workerSource = `
  const { createHash } = require('node:crypto');
  const { createReadStream } = require('node:fs');
  const { parentPort } = require('node:worker_threads');

  const hashFile = (path) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });

  parentPort.on('message', ({ id, paths }) => {
    Promise.all(paths.map(hashFile))
      .then((hashes) => parentPort.postMessage({ id, hashes }))
      .catch((error) => parentPort.postMessage({ id, error: String(error) }));
  });
`;

interface WorkerReply {
  readonly id: number;
  readonly hashes?: string[];
  readonly error?: string;
}

/* One long-lived worker serves all hashing; it idles between batches and is
   released once no requests remain in flight. */
let worker: Worker | undefined;
let nextRequestId = 0;
let inFlight = 0;
const pending = new Map<
  number,
  { resolve: (hashes: string[]) => void; reject: (error: Error) => void }
>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const spawned = new Worker(workerSource, { eval: true });
  spawned.unref();
  spawned.on('message', (message: WorkerReply) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.hashes) request.resolve(message.hashes);
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

export function hashFiles(
  paths: readonly string[]
): Effect.Effect<readonly string[], FileSystemError> {
  if (paths.length === 0) return Effect.succeed([]);
  return Effect.tryPromise({
    try: () => {
      const id = nextRequestId++;
      inFlight += 1;
      return new Promise<string[]>((resolve, reject) => {
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

export function hashFile(path: string): Effect.Effect<string, FileSystemError> {
  return hashFiles([path]).pipe(Effect.map((hashes) => hashes[0]));
}
