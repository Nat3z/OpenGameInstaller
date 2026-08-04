export const COMMUNITY_MARKETPLACE_URL = 'https://ogi-marketplace.nat3z.com';
export const COMMUNITY_MARKETPLACE_API_URL = `${COMMUNITY_MARKETPLACE_URL}/api/marketplace.json`;
const COMMUNITY_MARKETPLACE_CATALOG_URL =
  'https://raw.githubusercontent.com/OpenGameInstaller/marketplace/main/marketplace.json';

export interface CommunityAddon {
  name: string;
  author: string;
  source: string;
  img: string;
  description: string;
  pinnedCommit: string;
}

export function getCommunityAddonUrl(addon: CommunityAddon): string {
  return `${COMMUNITY_MARKETPLACE_URL}@${addon.source}`;
}

export async function getCommunityAddons(): Promise<CommunityAddon[]> {
  // The public API applies client-specific Cloudflare rules, so static web builds
  // read the same canonical catalog directly from the marketplace repository.
  const response = await fetch(COMMUNITY_MARKETPLACE_CATALOG_URL);

  if (!response.ok) {
    throw new Error(
      `Marketplace request failed with status ${response.status}`
    );
  }

  const addons: unknown = await response.json();
  if (!Array.isArray(addons)) {
    throw new Error('Marketplace response must be an array');
  }

  return addons as CommunityAddon[];
}
