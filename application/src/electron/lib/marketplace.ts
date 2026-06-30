import axios from 'axios';
import { tryCatch } from './tryCatch';

export type CommunityAddon = {
  name: string;
  author: string;
  source: string;
  img: string;
  description: string;
  pinnedCommit: string;
};

export class AddonMarketplace {
  private addons: CommunityAddon[];
  constructor(public url: string) {}
  async fetch() {
    let result = await tryCatch(async () => {
      return (await axios.get(this.url + '/api/marketplace.json', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'OpenGameInstaller Client/Rest1.0',
        },
      })) as CommunityAddon[];
    });

    if (result.error) {
      console.error(
        `addon-marketplace ${this.url}] Failed to fetch marketplace.`,
        result.error
      );
      return;
    }

    this.addons = result.data;
  }

  getAddons() {
    return this.addons;
  }

  getAddon(source: string) {
    return this.addons.find((a) => a.source === source);
  }
}
