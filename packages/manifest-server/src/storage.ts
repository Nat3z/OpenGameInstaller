import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Context, Data, Effect, Layer } from 'effect';

export class StorageError extends Data.TaggedError('StorageError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ManifestStorage extends Context.Tag('ManifestStorage')<
  ManifestStorage,
  {
    readonly get: (
      key: string
    ) => Effect.Effect<Uint8Array | undefined, StorageError>;
    /** Stores the manifest unless the key already exists; false means it lost to an earlier write. */
    readonly putIfAbsent: (
      key: string,
      data: Uint8Array
    ) => Effect.Effect<boolean, StorageError>;
  }
>() {}

function isNotFound(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return (
    code === 'ENOENT' ||
    code === 'NoSuchKey' ||
    code === 'NoSuchBucket' ||
    code === 'ERR_S3_FILE_NOT_FOUND'
  );
}

export const LocalStorageLive = (
  directory: string
): Layer.Layer<ManifestStorage> =>
  Layer.succeed(ManifestStorage, {
    get: (key) =>
      Effect.tryPromise({
        try: () => fs.readFile(join(directory, `${key}.json`)),
        catch: (cause) => cause,
      }).pipe(
        Effect.map((buffer): Uint8Array | undefined => new Uint8Array(buffer)),
        Effect.catchAll((cause) =>
          isNotFound(cause)
            ? Effect.succeed(undefined)
            : Effect.fail(
                new StorageError({
                  message: `Unable to read manifest ${key}`,
                  cause,
                })
              )
        )
      ),
    // link() fails atomically with EEXIST, so a concurrent submit for the same
    // key cannot clobber the first write the way rename() would.
    putIfAbsent: (key, data) => {
      const path = join(directory, `${key}.json`);
      return Effect.tryPromise({
        try: async () => {
          await fs.mkdir(dirname(path), { recursive: true });
          const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
          await fs.writeFile(temporary, data, { flag: 'wx' });
          try {
            await fs.link(temporary, path);
            return true;
          } catch (cause) {
            if ((cause as { code?: unknown } | null)?.code === 'EEXIST') {
              return false;
            }
            throw cause;
          } finally {
            await fs.rm(temporary, { force: true });
          }
        },
        catch: (cause) =>
          new StorageError({
            message: `Unable to write manifest ${key}`,
            cause,
          }),
      });
    },
  });

export interface S3StorageConfig {
  readonly endpoint?: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
}

export const S3StorageLive = (
  config: S3StorageConfig
): Layer.Layer<ManifestStorage> => {
  const client = new Bun.S3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
  const objectKey = (key: string): string => `manifests/${key}.json`;

  return Layer.succeed(ManifestStorage, {
    // `exists` first so a genuinely absent object is never confused with a
    // transport/permission failure, which must surface as a 500.
    get: (key) =>
      Effect.tryPromise({
        try: async () => {
          const file = client.file(objectKey(key));
          if (!(await file.exists())) return undefined;
          return new Uint8Array(await file.arrayBuffer());
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) =>
          isNotFound(cause)
            ? Effect.succeed(undefined)
            : Effect.fail(
                new StorageError({
                  message: `Unable to read manifest ${key}`,
                  cause,
                })
              )
        )
      ),
    // Bun's S3 client has no conditional PUT, so exists-then-write leaves a
    // narrow race between concurrent first submits; the loser's manifest wins.
    putIfAbsent: (key, data) =>
      Effect.tryPromise({
        try: async () => {
          const file = client.file(objectKey(key));
          if (await file.exists()) return false;
          await client.write(objectKey(key), data, {
            type: 'application/json',
          });
          return true;
        },
        catch: (cause) =>
          new StorageError({
            message: `Unable to write manifest ${key}`,
            cause,
          }),
      }),
  });
};
