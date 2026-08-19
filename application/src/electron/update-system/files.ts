import * as fs from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { FileSystemError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { hashFiles } from './hash.js';
import { isSafeRelativePath } from './model.js';

export interface ScannedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export function resolveInside(root: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, ...relativePath.split('/'));
  if (!target.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Path escapes update root: ${relativePath}`);
  }
  return target;
}

async function listFiles(root: string, directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

export function scanFiles(
  root: string
): Effect.Effect<readonly ScannedFile[], FileSystemError> {
  return Effect.gen(function* () {
    const paths = yield* Effect.tryPromise({
      try: () => listFiles(root, root),
      catch: (cause) =>
        new FileSystemError({
          message: `Unable to scan installation: ${String(cause)}`,
          path: root,
          cause,
        }),
    });
    const result: ScannedFile[] = [];
    for (let offset = 0; offset < paths.length; offset += 8) {
      const batch = paths.slice(offset, offset + 8);
      const hashes = yield* hashFiles(batch);
      const stats = yield* Effect.tryPromise({
        try: () => Promise.all(batch.map((path) => fs.stat(path))),
        catch: (cause) =>
          new FileSystemError({
            message: `Unable to inspect installation: ${String(cause)}`,
            path: root,
            cause,
          }),
      });
      result.push(
        ...batch.map((path, index) => ({
          path: relative(root, path).split(sep).join('/'),
          size: stats[index].size,
          sha256: hashes[index],
        }))
      );
    }
    return result.sort((left, right) => left.path.localeCompare(right.path));
  });
}

export async function writeJsonAtomic(
  path: string,
  value: unknown
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  await fs.rename(temporary, path);
}
