import type { APIRoute } from 'astro';
import { getCommunityAddons } from '../../lib/community-addons';

export const GET: APIRoute = async () => {
  const addons = await getCommunityAddons();
  return new Response(JSON.stringify(addons), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 's-maxage=7200, stale-while-revalidate=9000',
    },
  });
};
