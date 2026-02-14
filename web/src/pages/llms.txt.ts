import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';

const llmsFileUrl = new URL('../../llms.txt', import.meta.url);

export const GET: APIRoute = async () => {
  try {
    const content = await readFile(llmsFileUrl, 'utf8');
    return new Response(content, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  } catch {
    return new Response('llms.txt has not been generated yet.', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }
};
