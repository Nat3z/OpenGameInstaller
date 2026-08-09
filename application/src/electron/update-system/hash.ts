import { Worker } from 'node:worker_threads';
import { FileSystemError } from '@ogi-sdk/errors';
import { Effect } from 'effect';

const workerSource = `
  const { createHash } = require('node:crypto');
  const { createReadStream } = require('node:fs');
  const { parentPort, workerData } = require('node:worker_threads');

  const hashFile = (path) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });

  Promise.all(workerData.paths.map(hashFile))
    .then((hashes) => parentPort.postMessage({ hashes }))
    .catch((error) => parentPort.postMessage({ error: String(error) }));
`;

export function hashFiles(
  paths: readonly string[]
): Effect.Effect<readonly string[], FileSystemError> {
  if (paths.length === 0) return Effect.succeed([]);
  return Effect.async<readonly string[], FileSystemError>((resume) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { paths },
    });
    worker.once('message', (message: { hashes?: string[]; error?: string }) => {
      void worker.terminate();
      resume(
        message.hashes
          ? Effect.succeed(message.hashes)
          : Effect.fail(
              new FileSystemError({
                message: message.error ?? 'Hash worker failed',
              })
            )
      );
    });
    worker.once('error', (cause) => {
      resume(
        Effect.fail(new FileSystemError({ message: cause.message, cause }))
      );
    });
    return Effect.promise(() => worker.terminate()).pipe(Effect.asVoid);
  });
}

export function hashFile(path: string): Effect.Effect<string, FileSystemError> {
  return hashFiles([path]).pipe(Effect.map((hashes) => hashes[0]));
}
