import axios from 'axios';
import { canonicalizeAddonSource } from './addon-links';
import {
  assertMarketplaceUrlProtocol,
  type CommunityAddon,
  communityAddonArraySchema,
} from './marketplace-schema';
import { tryCatch } from './tryCatch';

export {
  assertMarketplaceUrlProtocol,
  type CommunityAddon,
  communityAddonArraySchema,
  communityAddonSchema,
  sanitizePinnedCommit,
} from './marketplace-schema';

function getMarketplaceJsonUrl(url: string): string {
  const marketplaceUrl = new URL(url);
  const hasFurtherPath = marketplaceUrl.pathname !== '/';

  if (!hasFurtherPath) {
    marketplaceUrl.pathname = '/api/marketplace.json';
  }

  return marketplaceUrl.toString();
}

export class AddonMarketplace {
  private addons: CommunityAddon[] = [];
  constructor(public url: string) {}

  /** Returns true when the marketplace JSON was fetched and parsed successfully. */
  async fetch(): Promise<boolean> {
    const previousAddons = this.addons;

    let result = await tryCatch(async () => {
      const marketplaceJsonUrl = getMarketplaceJsonUrl(this.url);
      assertMarketplaceUrlProtocol(marketplaceJsonUrl);

      return communityAddonArraySchema.parse(
        (
          await axios.get(marketplaceJsonUrl, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'OpenGameInstaller Client/Rest1.0',
            },
          })
        ).data
      );
    });

    if (result.error) {
      console.error(
        `[addon-marketplace ${this.url}] Failed to fetch marketplace.`,
        result.error
      );
      // Keep serving the last good catalog on transient refresh failures.
      this.addons = previousAddons;
      return false;
    }

    this.addons = result.data;
    return true;
  }

  getAddons() {
    return this.addons;
  }

  getAddon(source: string) {
    return this.addons.find(
      (a) =>
        canonicalizeAddonSource(a.source.toLowerCase()) ===
        canonicalizeAddonSource(source.toLowerCase())
    );
  }
}
