import axios from 'axios';
import { z } from 'zod';
import { tryCatch } from './tryCatch';

const communityAddon = z.object({
  name: z.string(),
  author: z.string(),
  source: z.string(),
  img: z.string(),
  description: z.string(),
  pinnedCommit: z.string().optional(),
});

export type CommunityAddon = z.infer<typeof communityAddon>;

function getMarketplaceJsonUrl(url: string): string {
  const marketplaceUrl = new URL(url);
  const hasFurtherPath = marketplaceUrl.pathname !== '/';

  if (!hasFurtherPath) {
    marketplaceUrl.pathname = '/api/marketplace.json';
  }

  return marketplaceUrl.toString();
}

export class AddonMarketplace {
  private addons: CommunityAddon[];
  constructor(public url: string) {}
  async fetch() {
    let result = await tryCatch(async () => {
      const marketplaceJsonUrl = getMarketplaceJsonUrl(this.url);

      return communityAddon.array().parse(
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
        `addon-marketplace ${this.url}] Failed to fetch marketplace.`,
        result.error
      );
      return;
    }

    this.addons = result.data.map((addon) => {
      return {
        ...addon,
        pinnedCommit: addon.pinnedCommit || 'latest',
      };
    });
  }

  getAddons() {
    return this.addons;
  }

  getAddon(source: string) {
    if (!this.addons) {
      throw new Error('Marketplace not fetched yet');
    }
    return this.addons.find(
      (a) => a.source.toLowerCase() === source.toLowerCase()
    );
  }
}
