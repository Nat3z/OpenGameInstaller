import axios from 'axios';
import { tryCatch } from './tryCatch';
import { z } from 'zod';

const communityAddon = z.object({
  name: z.string(),
  author: z.string(),
  source: z.string(),
  img: z.string(),
  description: z.string(),
  pinnedCommit: z.string().optional(),
});

export type CommunityAddon = z.infer<typeof communityAddon>;

export class AddonMarketplace {
  private addons: CommunityAddon[];
  constructor(public url: string) {}
  async fetch() {
    let result = await tryCatch(async () => {
      return communityAddon.array().parse(
        (
          await axios.get(this.url + '/api/marketplace.json', {
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
