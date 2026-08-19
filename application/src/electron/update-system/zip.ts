import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystemError } from '@ogi-sdk/errors';
import { Effect } from 'effect';
import { hashFile, hashFiles } from './hash.js';
import {
  isSafeRelativePath,
  sourceSetIdentity,
  type UpdateEntry,
  type UpdateManifest,
} from './model.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const MAX_EOCD_SIZE = 65_557;

interface ParsedEntry {
  readonly path: string;
  readonly crc32: number;
  readonly compression: UpdateEntry['compression'];
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  readonly dataStart: number;
}

function zipError(path: string, message: string): FileSystemError {
  return new FileSystemError({ message, path });
}

function findSignature(buffer: Buffer, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

async function readExactly(
  handle: fs.FileHandle,
  length: number,
  position: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('Unexpected end of ZIP archive');
  return buffer;
}

async function parseZip(path: string): Promise<readonly ParsedEntry[]> {
  const handle = await fs.open(path, 'r');
  try {
    const stat = await handle.stat();
    const tailSize = Math.min(stat.size, MAX_EOCD_SIZE);
    const tail = await readExactly(handle, tailSize, stat.size - tailSize);
    const eocdOffset = findSignature(tail, END_OF_CENTRAL_DIRECTORY);
    if (eocdOffset < 0) throw new Error('ZIP central directory was not found');

    const diskNumber = tail.readUInt16LE(eocdOffset + 4);
    const centralDisk = tail.readUInt16LE(eocdOffset + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralSize = tail.readUInt32LE(eocdOffset + 12);
    const centralOffset = tail.readUInt32LE(eocdOffset + 16);
    if (
      diskNumber !== 0 ||
      centralDisk !== 0 ||
      entriesOnDisk !== entryCount ||
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw new Error('Multipart and ZIP64 archives require a full download');
    }

    const central = await readExactly(handle, centralSize, centralOffset);
    const entries: ParsedEntry[] = [];
    let parsedEntryCount = 0;
    let offset = 0;
    while (offset < central.length) {
      if (central.readUInt32LE(offset) !== CENTRAL_HEADER) {
        throw new Error('Invalid ZIP central directory entry');
      }
      const flags = central.readUInt16LE(offset + 8);
      const method = central.readUInt16LE(offset + 10);
      const crc32 = central.readUInt32LE(offset + 16);
      const compressedSize = central.readUInt32LE(offset + 20);
      const size = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const disk = central.readUInt16LE(offset + 34);
      const localOffset = central.readUInt32LE(offset + 42);
      const name = central.subarray(offset + 46, offset + 46 + nameLength);
      const relativePath = name.toString(
        (flags & 0x800) !== 0 ? 'utf8' : 'latin1'
      );
      offset += 46 + nameLength + extraLength + commentLength;
      parsedEntryCount += 1;

      if (relativePath.endsWith('/')) continue;
      if (!isSafeRelativePath(relativePath)) {
        throw new Error(`Unsafe ZIP path: ${relativePath}`);
      }
      if ((flags & 0x1) !== 0) throw new Error('Encrypted ZIP archive');
      if (method !== 0 && method !== 8) {
        throw new Error(`Unsupported ZIP compression method: ${method}`);
      }
      if (disk !== 0) throw new Error('Multipart ZIP archive');

      const local = await readExactly(handle, 30, localOffset);
      if (local.readUInt32LE(0) !== LOCAL_HEADER) {
        throw new Error('Invalid ZIP local header');
      }
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      entries.push({
        path: relativePath,
        crc32,
        compression: method === 0 ? 'stored' : 'deflate',
        compressedSize,
        size,
        localOffset,
        dataStart: localOffset + 30 + localNameLength + localExtraLength,
      });
    }
    if (parsedEntryCount !== entryCount) {
      throw new Error('ZIP entry count does not match its central directory');
    }
    return entries;
  } finally {
    await handle.close();
  }
}

export interface BuildZipManifestInput {
  readonly archivePath: string;
  readonly extractedPath: string;
  readonly canonicalUrl: string;
  readonly etag?: string;
  readonly lastModified?: string;
}

export function buildZipManifest(
  input: BuildZipManifestInput
): Effect.Effect<UpdateManifest, FileSystemError> {
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => parseZip(input.archivePath),
      catch: (cause) =>
        zipError(input.archivePath, `Unable to inspect ZIP: ${String(cause)}`),
    });
    const archiveStat = yield* Effect.tryPromise({
      try: () => fs.stat(input.archivePath),
      catch: (cause) =>
        new FileSystemError({
          message: `Unable to stat ZIP: ${String(cause)}`,
          path: input.archivePath,
          cause,
        }),
    });
    const extractedFiles = entries.map((entry) =>
      join(input.extractedPath, ...entry.path.split('/'))
    );
    const hashes = yield* hashFilesInBatches(extractedFiles);
    const archiveHash = yield* hashFile(input.archivePath);
    const identity = sourceSetIdentity([{ url: input.canonicalUrl }]);
    return {
      schemaVersion: 1,
      encoding: 'canonical-json',
      sourceSetKey: identity.sourceSetKey,
      archive: { format: 'zip', multipart: false },
      sources: [
        {
          index: 0,
          urlHash: identity.urlHashes[0],
          size: archiveStat.size,
          sha256: archiveHash,
          ...(input.etag ? { etag: input.etag } : {}),
          ...(input.lastModified ? { lastModified: input.lastModified } : {}),
        },
      ],
      entries: entries.map((entry, index) => ({
        path: entry.path,
        size: entry.size,
        sha256: hashes[index],
        crc32: entry.crc32,
        compression: entry.compression,
        sourceIndex: 0,
        compressedSize: entry.compressedSize,
        dataOffset: entry.dataStart,
        range: {
          start: entry.localOffset,
          end: Math.max(
            entry.dataStart,
            entry.dataStart + entry.compressedSize - 1
          ),
        },
      })),
    };
  });
}

function hashFilesInBatches(
  paths: readonly string[]
): Effect.Effect<readonly string[], FileSystemError> {
  return Effect.gen(function* () {
    const hashes: string[] = [];
    for (let offset = 0; offset < paths.length; offset += 8) {
      hashes.push(...(yield* hashFiles(paths.slice(offset, offset + 8))));
    }
    return hashes;
  });
}
