import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import { resolveInside } from './files.js';
import { digestFile } from './hash.js';
import type {
  OwnershipManifest,
  UpdateEntry,
  UpdateManifest,
} from './model.js';
import { planUpdate } from './planner.js';

const logger = createLogger(LOGGER_PREFIXES.electron);
const sourceTimeoutMs = 7_500;
const centralHeader = 0x02014b50;
const endOfCentralDirectory = 0x06054b50;
const maximumCentralDirectoryBytes = 64 * 1024 * 1024;

export interface RemoteSource {
  readonly url: string;
}

export interface MaterializeInput {
  readonly manifest: UpdateManifest;
  readonly ownership: OwnershipManifest;
  readonly sources: readonly RemoteSource[];
  readonly outputPath: string;
}

interface RangeGroup {
  readonly sourceIndex: number;
  readonly start: number;
  readonly end: number;
  readonly entries: readonly UpdateEntry[];
}

export function materializeUpdate(
  input: MaterializeInput
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const plan = planUpdate(input.manifest, input.ownership);
    if (!plan) return false;
    if (!(yield* verifySources(input.manifest, input.sources))) return false;

    const verifiedReuse: Array<(typeof plan.reuse)[number]> = [];
    const failedReuse: UpdateEntry[] = [];
    for (const candidate of plan.reuse) {
      const installedPath = resolveInside(
        input.ownership.root,
        candidate.installedPath
      );
      const digest = yield* digestFile(installedPath).pipe(
        Effect.catchAll(() => Effect.succeed(undefined))
      );
      // sha256 alone only proves the file matches the community manifest,
      // which is untrusted; crc32 and size are cross-checked against the real
      // archive's central directory by verifyRemoteZipStructure, so requiring
      // all three ties every reused byte to the actual remote archive.
      if (
        digest &&
        digest.sha256 === candidate.entry.sha256 &&
        digest.crc32 === candidate.entry.crc32 &&
        digest.size === candidate.entry.size
      ) {
        verifiedReuse.push(candidate);
      } else {
        failedReuse.push(candidate.entry);
      }
    }
    const downloadEntries = [...plan.download, ...failedReuse];
    const rangeGroups = coalesce(
      downloadEntries.filter((entry) => entry.compressedSize > 0)
    );
    const transferBytes = rangeGroups.reduce(
      (total, group) => total + group.end - group.start + 1,
      0
    );
    if (transferBytes > plan.fullDownloadBytes * 0.8) return false;

    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(input.outputPath, { recursive: true });
        for (const candidate of verifiedReuse) {
          const source = resolveInside(
            input.ownership.root,
            candidate.installedPath
          );
          const destination = resolveInside(
            input.outputPath,
            candidate.entry.path
          );
          await fs.mkdir(dirname(destination), { recursive: true });
          await fs.copyFile(source, destination);
        }
        for (const entry of downloadEntries) {
          if (entry.compressedSize !== 0) continue;
          const destination = resolveInside(input.outputPath, entry.path);
          await fs.mkdir(dirname(destination), { recursive: true });
          await fs.writeFile(destination, Buffer.alloc(0));
        }
      },
      catch: (error) => error,
    });

    for (const group of rangeGroups) {
      const source = input.sources[group.sourceIndex];
      if (!source) return false;
      const rangesPath = join(input.outputPath, '.ogi-update-ranges');
      const rangePath = join(
        rangesPath,
        `${group.sourceIndex}-${group.start}-${group.end}`
      );
      yield* Effect.promise(() => fs.mkdir(rangesPath, { recursive: true }));
      if (!(yield* fetchRange(source.url, group.start, group.end, rangePath))) {
        return false;
      }
      for (const entry of group.entries) {
        const destination = resolveInside(input.outputPath, entry.path);
        if (!(yield* extractEntry(rangePath, group.start, entry, destination)))
          return false;
      }
      yield* Effect.promise(() => fs.rm(rangePath, { force: true }));
    }
    yield* Effect.promise(() =>
      fs.rm(join(input.outputPath, '.ogi-update-ranges'), {
        recursive: true,
        force: true,
      })
    );
    return true;
  }).pipe(
    Effect.catchAll((error) =>
      logger
        .warn(
          '[update] Optimized retrieval failed; using full download:',
          error
        )
        .pipe(Effect.as(false))
    )
  );
}

function verifySources(
  manifest: UpdateManifest,
  sources: readonly RemoteSource[]
): Effect.Effect<boolean> {
  return Effect.forEach(
    manifest.sources,
    (expected) => {
      const source = sources[expected.index];
      if (!source) return Effect.succeed(false);
      return Effect.tryPromise({
        try: async () => {
          const response = await fetch(source.url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(sourceTimeoutMs),
          });
          if (
            !response.ok ||
            response.headers.get('accept-ranges') === 'none'
          ) {
            return false;
          }
          const length = Number(response.headers.get('content-length'));
          if (!Number.isFinite(length) || length !== expected.size)
            return false;
          if (expected.etag && response.headers.get('etag') !== expected.etag) {
            return false;
          }
          if (
            expected.lastModified &&
            response.headers.get('last-modified') !== expected.lastModified
          ) {
            return false;
          }
          return true;
        },
        catch: (cause) => cause,
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));
    },
    { concurrency: 2 }
  ).pipe(
    Effect.flatMap((results) =>
      results.every(Boolean)
        ? verifyRemoteZipStructure(manifest, sources[0])
        : Effect.succeed(false)
    )
  );
}

function verifyRemoteZipStructure(
  manifest: UpdateManifest,
  source: RemoteSource | undefined
): Effect.Effect<boolean> {
  if (!source || manifest.sources.length !== 1) return Effect.succeed(false);
  const size = manifest.sources[0].size;
  return Effect.tryPromise({
    try: async () => {
      const tailSize = Math.min(size, 65_557);
      const tail = await fetchRangeBuffer(
        source.url,
        size - tailSize,
        size - 1,
        65_557
      );
      const eocdOffset = findSignature(tail, endOfCentralDirectory);
      if (eocdOffset < 0) return false;
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
        centralSize > maximumCentralDirectoryBytes ||
        centralOffset + centralSize > size
      ) {
        return false;
      }
      const central = await fetchRangeBuffer(
        source.url,
        centralOffset,
        centralOffset + centralSize - 1,
        maximumCentralDirectoryBytes
      );
      const entries: Array<{
        path: string;
        compression: UpdateEntry['compression'];
        crc32: number;
        compressedSize: number;
        size: number;
        localOffset: number;
      }> = [];
      let offset = 0;
      let parsed = 0;
      while (offset < central.length) {
        if (offset + 46 > central.length) return false;
        if (central.readUInt32LE(offset) !== centralHeader) return false;
        const flags = central.readUInt16LE(offset + 8);
        const method = central.readUInt16LE(offset + 10);
        const crc32 = central.readUInt32LE(offset + 16);
        const compressedSize = central.readUInt32LE(offset + 20);
        const entrySize = central.readUInt32LE(offset + 24);
        const nameLength = central.readUInt16LE(offset + 28);
        const extraLength = central.readUInt16LE(offset + 30);
        const commentLength = central.readUInt16LE(offset + 32);
        const disk = central.readUInt16LE(offset + 34);
        const localOffset = central.readUInt32LE(offset + 42);
        const end = offset + 46 + nameLength + extraLength + commentLength;
        if (end > central.length || disk !== 0 || (flags & 0x1) !== 0) {
          return false;
        }
        const path = central
          .subarray(offset + 46, offset + 46 + nameLength)
          .toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
        if (!path.endsWith('/')) {
          if (method !== 0 && method !== 8) return false;
          entries.push({
            path,
            compression: method === 0 ? 'stored' : 'deflate',
            crc32,
            compressedSize,
            size: entrySize,
            localOffset,
          });
        }
        offset = end;
        parsed += 1;
      }
      if (parsed !== entryCount || entries.length !== manifest.entries.length) {
        return false;
      }
      return entries.every((entry, index) => {
        const expected = manifest.entries[index];
        return (
          expected.path === entry.path &&
          expected.compression === entry.compression &&
          expected.crc32 === entry.crc32 &&
          expected.compressedSize === entry.compressedSize &&
          expected.size === entry.size &&
          expected.range.start === entry.localOffset
        );
      });
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
}

async function fetchRangeBuffer(
  url: string,
  start: number,
  end: number,
  maximumBytes: number
): Promise<Buffer> {
  if (end < start || end - start + 1 > maximumBytes) {
    throw new Error('ZIP structural range exceeds its limit');
  }
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(sourceTimeoutMs),
  });
  if (response.status !== 206) throw new Error('ZIP range request failed');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== end - start + 1) {
    throw new Error('ZIP structural range had an unexpected size');
  }
  return buffer;
}

function findSignature(buffer: Buffer, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function fetchRange(
  url: string,
  start: number,
  end: number,
  outputPath: string
): Effect.Effect<boolean> {
  const attempt = Effect.tryPromise({
    try: async () => {
      // A fixed whole-exchange deadline would abort large range bodies on
      // slow links; instead abort only after sourceTimeoutMs of inactivity.
      const controller = new AbortController();
      let inactivityTimer = setTimeout(
        () => controller.abort(),
        sourceTimeoutMs
      );
      const touch = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => controller.abort(), sourceTimeoutMs);
      };
      try {
        const response = await fetch(url, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: controller.signal,
        });
        if (response.status !== 206) {
          throw new Error(`Range request returned ${response.status}`);
        }
        if (!response.body) throw new Error('Range response has no body');
        const body = Readable.fromWeb(response.body as never);
        body.on('data', touch);
        await pipeline(body, createWriteStream(outputPath, { flags: 'wx' }));
      } finally {
        clearTimeout(inactivityTimer);
      }
      if ((await fs.stat(outputPath)).size !== end - start + 1) {
        throw new Error('Range request returned an unexpected byte count');
      }
      return true;
    },
    catch: (cause) => cause,
  });
  return attempt.pipe(
    Effect.tapError(() =>
      Effect.promise(() => fs.rm(outputPath, { force: true }))
    ),
    Effect.retry({ times: 2 }),
    Effect.catchAll(() => Effect.succeed(false))
  );
}

function extractEntry(
  rangePath: string,
  groupStart: number,
  entry: UpdateEntry,
  destination: string
): Effect.Effect<boolean> {
  return Effect.tryPromise({
    try: async () => {
      await fs.mkdir(dirname(destination), { recursive: true });
      const hash = createHash('sha256');
      let size = 0;
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          if (size > entry.size) {
            callback(new Error('Entry expanded beyond its declared size'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const localHeader = Buffer.alloc(30);
      const handle = await fs.open(rangePath, 'r');
      try {
        const { bytesRead } = await handle.read(
          localHeader,
          0,
          localHeader.length,
          entry.range.start - groupStart
        );
        if (
          bytesRead !== localHeader.length ||
          localHeader.readUInt32LE(0) !== 0x04034b50
        ) {
          return false;
        }
        const dataOffset =
          entry.range.start +
          30 +
          localHeader.readUInt16LE(26) +
          localHeader.readUInt16LE(28);
        if (dataOffset !== entry.dataOffset) return false;
      } finally {
        await handle.close();
      }
      // Opened only after validation so the early returns above cannot leak
      // the read stream's descriptor.
      const compressed = createReadStream(rangePath, {
        start: entry.dataOffset - groupStart,
        end: entry.range.end - groupStart,
      });
      if (entry.compression === 'deflate') {
        await pipeline(
          compressed,
          createInflateRaw(),
          verifier,
          createWriteStream(destination)
        );
      } else {
        await pipeline(compressed, verifier, createWriteStream(destination));
      }
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) {
        await fs.rm(destination, { force: true });
        return false;
      }
      return true;
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
}

function coalesce(entries: readonly UpdateEntry[]): readonly RangeGroup[] {
  const bySource = new Map<number, UpdateEntry[]>();
  for (const entry of entries) {
    const sourceEntries = bySource.get(entry.sourceIndex) ?? [];
    sourceEntries.push(entry);
    bySource.set(entry.sourceIndex, sourceEntries);
  }
  const groups: RangeGroup[] = [];
  for (const [sourceIndex, sourceEntries] of bySource) {
    const sorted = sourceEntries.sort(
      (left, right) => left.range.start - right.range.start
    );
    let current: RangeGroup | undefined;
    for (const entry of sorted) {
      if (!current || entry.range.start > current.end + 64 * 1024 + 1) {
        current = {
          sourceIndex,
          start: entry.range.start,
          end: entry.range.end,
          entries: [entry],
        };
        groups.push(current);
      } else {
        current = {
          ...current,
          end: Math.max(current.end, entry.range.end),
          entries: [...current.entries, entry],
        };
        groups[groups.length - 1] = current;
      }
    }
  }
  return groups;
}
