import {
  isSafeRelativePath,
  UPDATE_MANIFEST_VERSION,
} from '@ogi-sdk/manifest-server/schema';
import { Schema } from 'effect';

/* Shared update-manifest schema lives in @ogi-sdk/manifest-server/schema so
   the client and the community server validate against one definition. Only
   the ownership schemas below are app-specific. */
export {
  type CanonicalSource,
  canonicalJson,
  isSafeRelativePath,
  sha256,
  sourceSetIdentity,
  UPDATE_MANIFEST_VERSION,
  type UpdateEntry,
  UpdateEntrySchema,
  type UpdateManifest,
  UpdateManifestSchema,
  type UpdateSource,
  UpdateSourceSchema,
} from '@ogi-sdk/manifest-server/schema';

const Sha256 = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
const RelativePath = Schema.String.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => isSafeRelativePath(value), {
    message: () => 'Expected a safe relative path',
  })
);

export const OwnershipFileSchema = Schema.Struct({
  sourcePath: Schema.optional(RelativePath),
  installedPath: RelativePath,
  size: Schema.NonNegativeInt,
  sha256: Sha256,
});

export const OwnershipManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(UPDATE_MANIFEST_VERSION),
  appID: Schema.NonNegativeInt,
  root: Schema.String,
  sourceSetKey: Sha256,
  transactionId: Schema.optional(Schema.String),
  files: Schema.Array(OwnershipFileSchema),
});

export type OwnershipFile = typeof OwnershipFileSchema.Type;
export type OwnershipManifest = typeof OwnershipManifestSchema.Type;
