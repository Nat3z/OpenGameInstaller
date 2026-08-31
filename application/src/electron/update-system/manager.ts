import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { UpdateError } from '@ogi-sdk/errors';
import { Effect, Schema } from 'effect';
import { extraction } from 'ogi-addon';
import { getCommunityManifest, submitCommunityManifest } from './community.js';
import {
  type CanonicalSource,
  sourceSetIdentity,
  type UpdateManifest,
  UpdateManifestSchema,
} from './model.js';
import { materializeUpdate } from './remote.js';
import { registerStaging, removeStaging } from './staging.js';
import {
  commitTransaction,
  completeTransaction,
  type ExpectedLibraryUpdate,
  loadOwnership,
  prepareTransaction,
  rollbackTransaction,
} from './transaction.js';
import { buildZipManifest, validateZipStructure } from './zip.js';

export interface ManagedSource {
  readonly url: string;
  readonly localPath: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type PrepareDirectResult =
  | { readonly kind: 'fallback' }
  | {
      readonly kind: 'optimized';
      readonly extractedPath: string;
      readonly manifest: UpdateManifest;
    };

function updateError(message: string, cause?: unknown): UpdateError {
  return new UpdateError({ message, cause });
}

export function prepareDirectUpdate(input: {
  readonly appID: number;
  readonly installationPath: string;
  readonly sources: readonly ManagedSource[];
}): Effect.Effect<PrepareDirectResult> {
  return Effect.gen(function* () {
    if (
      input.sources.length === 0 ||
      input.sources.some(
        (source) => source.headers && Object.keys(source.headers).length > 0
      )
    ) {
      return { kind: 'fallback' as const };
    }
    const ownership = yield* loadOwnership(input.appID);
    if (!ownership) return { kind: 'fallback' as const };
    // The key is content-addressed, so each source's current size/etag must be
    // observed before any manifest can be looked up.
    const metadata = yield* Effect.forEach(
      input.sources,
      (source) => inspectRemoteSource(source.url),
      { concurrency: 2 }
    );
    const canonicalSources: CanonicalSource[] = [];
    for (const [index, source] of input.sources.entries()) {
      const size = metadata[index].size;
      // No content-length means no key, and therefore no manifest to look up.
      if (size === undefined) return { kind: 'fallback' as const };
      canonicalSources.push({
        url: source.url,
        size,
        ...(metadata[index].etag ? { etag: metadata[index].etag } : {}),
      });
    }
    const identity = sourceSetIdentity(canonicalSources);
    const manifest = yield* getCommunityManifest(identity.sourceSetKey);
    if (
      !manifest ||
      manifest.sourceSetKey !== identity.sourceSetKey ||
      manifest.sources.length !== input.sources.length ||
      manifest.sources.some(
        (source, index) => source.urlHash !== identity.urlHashes[index]
      )
    ) {
      return { kind: 'fallback' as const };
    }
    const extractedPath = join(
      dirname(input.sources[0].localPath),
      `.ogi-managed-update-${randomUUID()}`
    );
    yield* registerStaging(extractedPath).pipe(
      Effect.mapError((cause) =>
        updateError('Unable to prepare managed extraction', cause)
      )
    );
    const materialized = yield* materializeUpdate({
      manifest,
      ownership,
      sources: input.sources,
      outputPath: extractedPath,
    });
    if (!materialized) {
      yield* removeStaging(extractedPath);
    }
    return materialized
      ? { kind: 'optimized' as const, extractedPath, manifest }
      : { kind: 'fallback' as const };
  }).pipe(Effect.catchAll(() => Effect.succeed({ kind: 'fallback' as const })));
}

export function extractManagedDownload(input: {
  readonly sources: readonly ManagedSource[];
  readonly downloadId?: string;
}): Effect.Effect<
  { readonly extractedPath: string; readonly manifest: UpdateManifest },
  UpdateError
> {
  return Effect.gen(function* () {
    if (input.sources.length !== 1) {
      return yield* Effect.fail(
        updateError('Managed multipart extraction is not supported')
      );
    }
    const source = input.sources[0];
    if (extname(source.localPath).toLowerCase() !== '.zip') {
      return yield* Effect.fail(
        updateError('Managed extraction currently requires a ZIP archive')
      );
    }
    const extractedPath = join(
      dirname(source.localPath),
      `.ogi-managed-extract-${randomUUID()}`
    );
    // Validate the archive's structure (traversal paths, encryption, ZIP64)
    // BEFORE extraction so a hostile ZIP can never write outside staging.
    yield* validateZipStructure(source.localPath).pipe(
      Effect.mapError((cause) =>
        updateError('Downloaded archive failed validation', cause)
      )
    );
    yield* registerStaging(extractedPath).pipe(
      Effect.mapError((cause) =>
        updateError('Unable to prepare managed extraction', cause)
      )
    );
    yield* Effect.tryPromise({
      try: () => extraction(source.localPath, extractedPath),
      catch: (cause) => updateError('Managed extraction failed', cause),
    }).pipe(Effect.tapError(() => removeStaging(extractedPath)));
    const metadata = yield* inspectRemoteSource(source.url);
    const manifest = yield* buildZipManifest({
      archivePath: source.localPath,
      extractedPath,
      canonicalUrl: source.url,
      ...(metadata.etag ? { etag: metadata.etag } : {}),
      ...(metadata.lastModified ? { lastModified: metadata.lastModified } : {}),
    }).pipe(
      Effect.mapError((cause) =>
        updateError('Unable to build update manifest', cause)
      ),
      Effect.tapError(() => removeStaging(extractedPath))
    );
    yield* submitCommunityManifest(manifest);
    // A failed archive delete must not discard a valid extraction + manifest.
    yield* Effect.tryPromise({
      try: () => fs.rm(source.localPath, { force: true }),
      catch: (cause) => cause,
    }).pipe(Effect.ignore);
    return { extractedPath, manifest };
  });
}

export function beginManagedSetup(input: {
  readonly appID: number;
  readonly installationPath: string;
  readonly extractedPath: string;
  readonly manifest: unknown;
}) {
  return Schema.decodeUnknown(UpdateManifestSchema, {
    onExcessProperty: 'error',
  })(input.manifest).pipe(
    Effect.mapError((cause) => updateError('Invalid update manifest', cause)),
    Effect.flatMap((manifest) =>
      prepareTransaction({
        appID: input.appID,
        installationPath: input.installationPath,
        extractedPath: input.extractedPath,
        manifest: manifest as UpdateManifest,
      })
    ),
    Effect.mapError((cause) =>
      cause instanceof UpdateError
        ? cause
        : updateError('Unable to prepare update transaction', cause)
    )
  );
}

export function finishManagedSetup(input: {
  readonly transactionId: string;
  readonly installationPath: string;
  readonly manifest: unknown;
  readonly expectedLibrary: ExpectedLibraryUpdate;
}) {
  return Schema.decodeUnknown(UpdateManifestSchema, {
    onExcessProperty: 'error',
  })(input.manifest).pipe(
    Effect.mapError((cause) => updateError('Invalid update manifest', cause)),
    Effect.flatMap((manifest) =>
      commitTransaction(
        input.transactionId,
        manifest as UpdateManifest,
        input.installationPath,
        input.expectedLibrary
      )
    ),
    Effect.mapError((cause) =>
      cause instanceof UpdateError
        ? cause
        : updateError('Unable to commit update transaction', cause)
    )
  );
}

export function completeManagedSetup(transactionId: string) {
  return completeTransaction(transactionId).pipe(
    Effect.mapError((cause) =>
      updateError('Unable to complete update transaction', cause)
    )
  );
}

export function abortManagedSetup(transactionId: string) {
  return rollbackTransaction(transactionId).pipe(
    Effect.mapError((cause) => updateError('Unable to roll back update', cause))
  );
}

interface RemoteSourceMetadata {
  readonly size?: number;
  readonly etag?: string;
  readonly lastModified?: string;
}

/** Fail-soft HEAD probe: callers that require a field treat its absence as a
    reason to fall back rather than as an error. */
function inspectRemoteSource(url: string): Effect.Effect<RemoteSourceMetadata> {
  return Effect.tryPromise({
    try: async (): Promise<RemoteSourceMetadata> => {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return {};
      // `Number(null)` and `Number('')` are both 0, so an absent or blank
      // content-length must be rejected before the numeric check.
      const rawLength = response.headers.get('content-length')?.trim();
      const length = rawLength ? Number(rawLength) : Number.NaN;
      const size =
        Number.isSafeInteger(length) && length > 0 ? length : undefined;
      const etag = response.headers.get('etag') ?? undefined;
      const lastModified = response.headers.get('last-modified') ?? undefined;
      return {
        ...(size === undefined ? {} : { size }),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    },
    catch: (cause) => cause,
  }).pipe(Effect.catchAll(() => Effect.succeed({})));
}
