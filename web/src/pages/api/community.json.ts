import type { APIRoute } from 'astro';
import fm from 'front-matter';
import { readdirSync, readFileSync } from 'fs';

export const GET: APIRoute = async () => {
  let files = readdirSync('community');
  files = files.filter((file) => file !== 'template.md');
  const addonDetail = files.map((file) => {
    const md = readFileSync(`community/${file}`, 'utf-8');
    const content = fm(md);

    let attributes = content.attributes as {
      name: string;
      author: string;
      source: string;
      img: string;
      pinnedCommit: string;
    };

    return {
      name: attributes.name,
      author: attributes.author,
      source: attributes.source,
      img: attributes.img,
      pinnedCommit: attributes.pinnedCommit,
      description: content.body,
    };
  });
  return new Response(JSON.stringify(addonDetail), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 's-maxage=7200, stale-while-revalidate=9000',
    },
  });
};
