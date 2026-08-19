import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { UpdateError } from '@ogi-sdk/errors';
import { Effect, Schema } from 'effect';
import { extraction } from 'ogi-addon';
import { getCommunityManifest, submitCommunityManifest } from './community.js';
import {
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
import { buildZipManifest } from './zip.js';

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
    const identity = sourceSetIdentity(
      input.sources.map((source) => ({ url: source.url }))
    );
    const ownership = yield* loadOwnership(input.appID);
    if (!ownership) return { kind: 'fallback' as const };
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
    yield* registerStaging(extractedPath).pipe(
      Effect.mapError((cause) =>
        updateError('Unable to prepare managed extraction', cause)
      )
    );
    yield* extraction(source.localPath, extractedPath).pipe(
      Effect.mapError((cause) =>
        updateError('Managed extraction failed', cause)
      ),
      Effect.tapError(() => removeStaging(extractedPath))
    );
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
    yield* Effect.tryPromise({
      try: () => fs.rm(source.localPath, { force: true }),
      catch: (cause) =>
        updateError('Unable to remove downloaded archive', cause),
    }).pipe(Effect.tapError(() => removeStaging(extractedPath)));
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

function inspectRemoteSource(url: string): Effect.Effect<{
  readonly etag?: string;
  readonly lastModified?: string;
}> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return {};
      const etag = response.headers.get('etag') ?? undefined;
      const lastModified = response.headers.get('last-modified') ?? undefined;
      return {
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    },
    catch: (cause) => cause,
  }).pipe(Effect.catchAll(() => Effect.succeed({})));
}
