import { ValidationError } from '@ogi-sdk/errors';
import { Schema } from 'effect';

export function sanitizePinnedCommit(value?: string): string {
  if (!value || value === 'latest') return 'latest';
  assertNoShellInjection(value, 'pinnedCommit');
  if (/^[0-9a-f]{7,40}$/i.test(value)) return value;
  return !value.startsWith('-') &&
    !value.includes('..') &&
    /^[a-zA-Z0-9][\w./-]*$/.test(value)
    ? value
    : 'latest';
}

export function assertMarketplaceUrlProtocol(url: string): void {
  const { protocol } = new URL(url);
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new ValidationError({
      message: `Unsupported marketplace protocol: ${protocol}`,
      field: 'url',
    });
  }
}

const SHELL_META_RE = /[`$;|&{}\n\r\\]/;
export function assertNoShellInjection(value: string, fieldName: string): void {
  if (SHELL_META_RE.test(value)) {
    throw new ValidationError({
      message: `Invalid shell metacharacters in ${fieldName}`,
      field: fieldName,
    });
  }
}

const PinnedCommitSchema = Schema.transform(
  Schema.Union(Schema.String, Schema.Undefined),
  Schema.String,
  { strict: true, decode: sanitizePinnedCommit, encode: (value) => value }
);

export const communityAddonSchema = Schema.Struct({
  name: Schema.String,
  author: Schema.String,
  source: Schema.String,
  img: Schema.String,
  description: Schema.String,
  pinnedCommit: PinnedCommitSchema,
});
export const communityAddonArraySchema = Schema.Array(communityAddonSchema);
export type CommunityAddon = Schema.Schema.Type<typeof communityAddonSchema>;
