import { gzipSync } from 'node:zlib';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Schema } from 'effect';
import {
  canonicalJson,
  type UpdateManifest,
  UpdateManifestSchema,
} from './model.js';

const logger = createLogger(LOGGER_PREFIXES.electron);
const requestTimeoutMs = 3_000;
const maximumManifestBytes = 8 * 1024 * 1024;

function endpoint(): string | undefined {
  const value = process.env.OGI_UPDATE_MANIFEST_URL?.trim();
  return value ? value.replace(/\/$/, '') : undefined;
}

export function getCommunityManifest(
  sourceSetKey: string
): Effect.Effect<UpdateManifest | undefined> {
  const baseUrl = endpoint();
  if (!baseUrl) return Effect.succeed(undefined);
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `${baseUrl}/v1/manifests/${encodeURIComponent(sourceSetKey)}`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(requestTimeoutMs),
        }
      );
      if (!response.ok) return undefined;
      const declaredLength = Number(response.headers.get('content-length'));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > maximumManifestBytes
      ) {
        return undefined;
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > maximumManifestBytes) return undefined;
      const body: unknown = JSON.parse(text);
      const candidate =
        typeof body === 'object' && body !== null && 'manifest' in body
          ? (body as { manifest: unknown }).manifest
          : body;
      return await Effect.runPromise(
        Schema.decodeUnknown(UpdateManifestSchema, {
          onExcessProperty: 'error',
        })(candidate)
      );
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      logger
        .warn('[update] Community manifest lookup unavailable:', error)
        .pipe(Effect.as(undefined))
    )
  );
}

export function submitCommunityManifest(
  manifest: UpdateManifest
): Effect.Effect<void> {
  const baseUrl = endpoint();
  if (!baseUrl) return Effect.void;
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl}/v1/manifests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
        body: gzipSync(canonicalJson(manifest)),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Manifest endpoint returned ${response.status}`);
      }
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      logger
        .warn('[update] Community manifest submission unavailable:', error)
        .pipe(Effect.asVoid)
    )
  );
}
