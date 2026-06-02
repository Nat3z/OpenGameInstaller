/**
 * Bun nests webtorrent's runtime dependencies as siblings in the store, not under
 * application/node_modules. electron-builder only packages application/node_modules,
 * so copy any missing siblings before pack.
 */
import { access, cp, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const appRoot = join(fileURLToPath(import.meta.url), '..', '..');
const appNodeModules = join(appRoot, 'node_modules');
const webtorrentReal = realpathSync(join(appNodeModules, 'webtorrent'));
const webtorrentNest = dirname(webtorrentReal);

for (const entry of await readdir(webtorrentNest)) {
  if (entry === 'webtorrent') continue;

  const src = join(webtorrentNest, entry);
  const dest = join(appNodeModules, entry);

  try {
    await access(dest);
    continue;
  } catch {
    await cp(src, dest, { recursive: true, dereference: true });
    console.log(`sync-pack-deps: linked ${entry} for electron packaging`);
  }
}
