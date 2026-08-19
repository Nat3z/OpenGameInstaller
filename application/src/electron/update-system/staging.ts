import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { FileSystemError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { __dirname as ogiDirectory } from '@/electron/manager/manager.paths.js';
import { writeJsonAtomic } from './files.js';

const stagingDirectory = join(
  ogiDirectory,
  'internals',
  'update-system',
  'staging'
);

interface StagingMarker {
  readonly id: string;
  readonly path: string;
}

function registryPath(id: string): string {
  return join(stagingDirectory, `${id}.json`);
}

function stagingError(path: string, cause: unknown): FileSystemError {
  return new FileSystemError({
    message: `Unable to manage update staging: ${String(cause)}`,
    path,
    cause,
  });
}

export function registerStaging(
  path: string
): Effect.Effect<void, FileSystemError> {
  return Effect.tryPromise({
    try: async (): Promise<void> => {
      try {
        const marker: StagingMarker = { id: randomUUID(), path };
        await fs.mkdir(path, { recursive: true });
        await writeJsonAtomic(registryPath(marker.id), marker);
      } catch (cause) {
        await fs.rm(path, { recursive: true, force: true });
        throw cause;
      }
    },
    catch: (cause) => stagingError(path, cause),
  });
}

export function adoptStaging(
  path: string
): Effect.Effect<void, FileSystemError> {
  return Effect.tryPromise({
    try: async () => {
      const marker = await findMarker(path);
      if (!marker) throw new Error('Staging registration was not found');
      await fs.rm(registryPath(marker.id), { force: true });
    },
    catch: (cause) => stagingError(path, cause),
  });
}

export function removeStaging(path: string): Effect.Effect<void> {
  return Effect.tryPromise({
    try: async () => {
      await fs.rm(path, { recursive: true, force: true });
      const marker = await findMarker(path);
      if (marker) await fs.rm(registryPath(marker.id), { force: true });
    },
    catch: () => undefined,
  }).pipe(Effect.ignore);
}

export function recoverStaging(): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => fs.readdir(stagingDirectory),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll(() => Effect.succeed([])),
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries.filter((entry) => entry.endsWith('.json')),
        (entry) => recoverMarker(join(stagingDirectory, entry)),
        { concurrency: 1, discard: true }
      )
    )
  );
}

function recoverMarker(path: string): Effect.Effect<void> {
  return Effect.tryPromise({
    try: async () => {
      try {
        const marker = JSON.parse(
          await fs.readFile(path, 'utf8')
        ) as StagingMarker;
        if (basename(marker.path).startsWith('.ogi-managed-')) {
          await fs.rm(marker.path, { recursive: true, force: true });
        }
      } finally {
        await fs.rm(path, { force: true });
      }
    },
    catch: () => undefined,
  }).pipe(Effect.ignore);
}

async function findMarker(path: string): Promise<StagingMarker | undefined> {
  const entries = await fs.readdir(stagingDirectory).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const marker = JSON.parse(
      await fs.readFile(join(stagingDirectory, entry), 'utf8')
    ) as StagingMarker;
    if (
      marker.path === path &&
      registryPath(marker.id) === join(stagingDirectory, entry)
    ) {
      return marker;
    }
  }
  return undefined;
}
