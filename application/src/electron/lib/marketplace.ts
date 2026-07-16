import axios from 'axios';
import { HttpError, ValidationError, formatError } from '@ogi/errors';
import { Effect, Schema } from 'effect';
import { canonicalizeAddonSource } from './addon-links';
import {
  assertMarketplaceUrlProtocol,
  assertNoShellInjection,
  type CommunityAddon,
  communityAddonArraySchema,
} from './marketplace-schema';

export {
  assertMarketplaceUrlProtocol,
  assertNoShellInjection,
  type CommunityAddon,
  communityAddonArraySchema,
  communityAddonSchema,
  sanitizePinnedCommit,
} from './marketplace-schema';

const marketplaceJsonUrl = (url: string): Effect.Effect<string, ValidationError> =>
  Effect.try({
    try: () => {
      assertNoShellInjection(url, 'marketplace URL');
      const parsed = new URL(url);
      if (parsed.pathname === '/') parsed.pathname = '/api/marketplace.json';
      assertMarketplaceUrlProtocol(parsed.toString());
      return parsed.toString();
    },
    catch: (cause) => new ValidationError({ message: formatError(cause), field: 'url' }),
  });

export class AddonMarketplace {
  private addons: ReadonlyArray<CommunityAddon> = [];
  constructor(public readonly url: string) {}

  fetchEffect(): Effect.Effect<boolean> {
    const previous = this.addons;
    return Effect.gen(this, function* () {
      const url = yield* marketplaceJsonUrl(this.url);
      const response = yield* Effect.tryPromise({
        try: () => axios.get(url, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenGameInstaller Client/Rest1.0' } }),
        catch: (cause: any) => new HttpError({ message: cause?.message ?? 'Marketplace request failed', statusCode: cause?.response?.status ?? 0, url }),
      });
      const addons = yield* Schema.decodeUnknown(communityAddonArraySchema)(response.data).pipe(
        Effect.mapError((cause) => new ValidationError({ message: String(cause) }))
      );
      for (const addon of addons) assertNoShellInjection(addon.pinnedCommit, 'pinnedCommit');
      this.addons = addons;
      return true;
    }).pipe(Effect.catchAll((error) => Effect.sync(() => {
      console.error(`[addon-marketplace ${this.url}] Failed to fetch marketplace.`, error);
      this.addons = previous;
      return false;
    })));
  }

  fetch(): Promise<boolean> { return Effect.runPromise(this.fetchEffect()); }
  getAddons(): ReadonlyArray<CommunityAddon> { return this.addons; }
  getAddon(source: string): CommunityAddon | undefined {
    const canonical = canonicalizeAddonSource(source);
    return this.addons.find((addon) => canonicalizeAddonSource(addon.source) === canonical);
  }
}
