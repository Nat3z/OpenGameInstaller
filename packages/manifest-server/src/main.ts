import { Effect, type Layer } from 'effect';
import { createServer } from './server.js';
import {
  LocalStorageLive,
  type ManifestStorage,
  S3StorageLive,
} from './storage.js';

const DEFAULT_PORT = 8619;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function resolveStorage(): {
  readonly layer: Layer.Layer<ManifestStorage>;
  readonly description: string;
} {
  const kind = process.env.MANIFEST_STORAGE?.trim() || 'local';
  if (kind === 's3') {
    const bucket = required('S3_BUCKET');
    const endpoint = process.env.S3_ENDPOINT?.trim();
    // Signed requests carry credentials; never let them travel cleartext.
    if (endpoint?.startsWith('http://')) {
      throw new Error(
        'S3_ENDPOINT must use https:// — credentialed requests over cleartext are not allowed'
      );
    }
    return {
      layer: S3StorageLive({
        endpoint,
        bucket,
        region: process.env.S3_REGION?.trim() || 'auto',
        accessKeyId: required('S3_ACCESS_KEY_ID'),
        secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      }),
      description: `s3 bucket ${bucket}`,
    };
  }
  if (kind !== 'local') {
    throw new Error(`Unknown MANIFEST_STORAGE value "${kind}"`);
  }
  const directory = process.env.MANIFEST_DATA_DIR?.trim() || './data';
  return {
    layer: LocalStorageLive(directory),
    description: `local directory ${directory}`,
  };
}

const port = Number(process.env.PORT?.trim() || DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT value "${process.env.PORT}"`);
}

const storage = resolveStorage();

await Effect.runPromise(
  createServer({ port }).pipe(
    Effect.tap((server) =>
      Effect.log(
        `[manifest] Listening on ${server.url} using ${storage.description}`
      )
    ),
    // Bun.serve keeps the process alive once this effect resolves.
    Effect.provide(storage.layer)
  )
);
