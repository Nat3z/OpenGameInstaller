import { z } from 'zod';

/** Reject option-like or otherwise unsafe git refs from marketplace JSON. */
export function sanitizePinnedCommit(value?: string): string {
  if (!value || value === 'latest') {
    return 'latest';
  }
  if (/^[0-9a-f]{7,40}$/i.test(value)) {
    return value;
  }
  // Safe ref name: no leading dash (git option injection), no path tricks.
  if (
    !value.startsWith('-') &&
    !value.includes('..') &&
    /^[a-zA-Z0-9][\w./-]*$/.test(value)
  ) {
    return value;
  }
  return 'latest';
}

export function assertMarketplaceUrlProtocol(url: string): void {
  const { protocol } = new URL(url);
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`Unsupported marketplace protocol: ${protocol}`);
  }
}

export const communityAddonSchema = z.object({
  name: z.string(),
  author: z.string(),
  source: z.string(),
  img: z.string(),
  description: z.string(),
  pinnedCommit: z
    .string()
    .optional()
    .transform((value) => sanitizePinnedCommit(value)),
});

export const communityAddonArraySchema = communityAddonSchema.array();

export type CommunityAddon = z.infer<typeof communityAddonSchema>;
