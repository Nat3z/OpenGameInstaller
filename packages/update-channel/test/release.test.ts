import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import {
  type ChannelRelease,
  compareReleases,
  downloadAsset,
  findApplicationUpdate,
  findSetupUpdate,
  platformAsset,
} from '../src/index';

const release = (
  tag: string,
  setup = '2.0.0',
  published = '2026-01-01T00:00:00Z'
): ChannelRelease => ({
  tag_name: tag,
  prerelease: false,
  created_at: published,
  published_at: published,
  body: `Setup Version: ${setup}\nApplication Version: ${tag}`,
  assets: [
    {
      name: 'OpenGameInstaller-Portable.zip',
      browser_download_url: '',
      size: 1,
    },
    {
      name: 'OpenGameInstaller-linux-pt.AppImage',
      browser_download_url: '',
      size: 1,
    },
    { name: 'OpenGameInstaller-Setup.exe', browser_download_url: '', size: 1 },
    {
      name: 'OpenGameInstaller-Setup.AppImage',
      browser_download_url: '',
      size: 1,
    },
  ],
});

test('application updates walk the feed from the installed release', () => {
  const feed = ['v4.3.0', 'v4.4.0', 'v4.2.0', 'v4.1.0']
    .map((tag) => release(tag))
    .sort(compareReleases);
  const update = findApplicationUpdate(feed, 'v4.1.0', 'stable');
  expect(update?.release.tag_name).toBe('v4.4.0');
  expect(update?.path.map((step) => step.tag_name)).toEqual([
    'v4.2.0',
    'v4.3.0',
    'v4.4.0',
  ]);
  expect(findApplicationUpdate(feed, 'v4.4.0', 'stable')).toBeUndefined();
  // Releases missing from the feed have no incremental path.
  expect(findApplicationUpdate(feed, 'v3.0.0', 'stable')?.path).toEqual([]);
});

test('setup updates skip releases shipping the installed setup', () => {
  const feed = [release('v4.4.0', '2.1.0'), release('v4.3.0', '2.0.0')];
  expect(findSetupUpdate(feed, '2.0.0', 'stable')?.version).toBe('2.1.0');
  expect(findSetupUpdate(feed, '2.1.0', 'stable')).toBeUndefined();
  expect(findSetupUpdate(feed, '2.2.0', 'stable')).toBeUndefined();
  // a newest release shipping an older setup doesn't hide a newer one
  const rolledBack = [release('v4.5.0', '1.0.0'), ...feed];
  expect(findSetupUpdate(rolledBack, '2.0.0', 'stable')?.version).toBe('2.1.0');
});

test('non-semver tags sort after semver releases', () => {
  const feed = [
    release('custom', '2.0.0', '2027-01-01T00:00:00Z'),
    release('v4.3.0'),
    release('v4.4.0'),
  ].sort(compareReleases);
  expect(feed.map((step) => step.tag_name)).toEqual([
    'v4.4.0',
    'v4.3.0',
    'custom',
  ]);
});

test('platform assets match each executable', () => {
  const latest = release('v4.4.0');
  expect(platformAsset(latest, 'application', 'win32')?.name).toBe(
    'OpenGameInstaller-Portable.zip'
  );
  expect(platformAsset(latest, 'application', 'linux')?.name).toBe(
    'OpenGameInstaller-linux-pt.AppImage'
  );
  expect(platformAsset(latest, 'setup', 'win32')?.name).toBe(
    'OpenGameInstaller-Setup.exe'
  );
  expect(platformAsset(latest, 'setup', 'linux')?.name).toBe(
    'OpenGameInstaller-Setup.AppImage'
  );
  expect(platformAsset(latest, 'setup', 'darwin')).toBeUndefined();
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('downloads retry transient failures and reject tampered artifacts', async () => {
  const payload = Buffer.from('open game installer');
  const sha256 = createHash('sha256').update(payload).digest('hex');
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === '/flaky' && ++requests === 1
        ? new Response('busy', { status: 503 })
        : new Response(payload),
  });
  const directory = mkdtempSync(join(tmpdir(), 'ogi-release-'));
  directories.push(directory);
  const destination = join(directory, 'artifact');
  try {
    await Effect.runPromise(
      downloadAsset(
        {
          name: 'artifact',
          browser_download_url: `${server.url}flaky`,
          size: payload.length,
          digest: `sha256:${sha256}`,
        },
        destination
      )
    );
    expect(requests).toBe(2);
    expect(readFileSync(destination)).toEqual(payload);

    const tampered = await Effect.runPromise(
      Effect.flip(
        downloadAsset(
          {
            name: 'artifact',
            browser_download_url: `${server.url}tampered`,
            size: payload.length,
            sha256: '0'.repeat(64),
          },
          destination
        )
      )
    );
    expect(tampered.phase).toBe('verify-asset');
  } finally {
    server.stop(true);
  }
  expect(existsSync(destination)).toBe(false);
});

test('downloads fail fast on 404 and stop retrying at the cap', async () => {
  const requests: Record<string, number> = {};
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      requests[path] = (requests[path] ?? 0) + 1;
      return new Response('nope', { status: path === '/busy' ? 503 : 404 });
    },
  });
  const directory = mkdtempSync(join(tmpdir(), 'ogi-release-'));
  directories.push(directory);
  const download = (path: string) =>
    Effect.runPromise(
      Effect.flip(
        downloadAsset(
          {
            name: 'artifact',
            browser_download_url: `${server.url}${path}`,
            size: 1,
          },
          join(directory, 'artifact')
        )
      )
    );
  try {
    await download('missing');
    expect(requests['/missing']).toBe(1);
    await download('busy');
    expect(requests['/busy']).toBe(4);
  } finally {
    server.stop(true);
  }
}, 20_000);
