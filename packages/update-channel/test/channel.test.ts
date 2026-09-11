import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptsRelease,
  channelStatePath,
  parseNightlyManifest,
  resolveChannel,
  saveChannel,
  shouldUpdateApplication,
  shouldUpdateSetup,
} from '../src/index';

const directories: string[] = [];
function installation(): { root: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), 'ogi-channel-'));
  directories.push(root);
  return { root, state: channelStatePath(root, join(root, 'installation')) };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('nightly bootstrap persists an explicit return to stable across replacement', () => {
  const { root, state } = installation();
  expect(resolveChannel(state, root, '2.2.1-nightly.100')).toBe('nightly');
  saveChannel(state, 'stable');
  expect(resolveChannel(state, root, '2.2.1-nightly.101')).toBe('stable');
});

test('legacy source marker takes priority over unstable and embedded nightly', () => {
  const { root, state } = installation();
  writeFileSync(join(root, 'bleeding-edge.txt'), 'true');
  writeFileSync(join(root, 'COMMIT_EDGE.txt'), 'main');
  expect(resolveChannel(state, root, '2.2.1-nightly.100')).toBe(
    'bleeding-edge'
  );
});

test('legacy unstable migrates and installation paths are isolated', () => {
  const { root, state } = installation();
  writeFileSync(join(root, 'bleeding-edge.txt'), 'true');
  expect(resolveChannel(state, root, '2.2.0')).toBe('unstable');
  expect(channelStatePath(root, join(root, 'other'))).not.toBe(state);
});

test('invalid persisted state cannot silently change channels', () => {
  const { root, state } = installation();
  saveChannel(state, 'nightly');
  writeFileSync(state, '{"channel":"unknown"}');
  expect(() => resolveChannel(state, root, '2.2.0')).toThrow();
});

test('stable and unstable feeds exclude nightly releases', () => {
  for (const channel of ['stable', 'unstable'] as const) {
    expect(
      acceptsRelease(channel, { tag_name: 'nightly', prerelease: true })
    ).toBe(false);
    expect(
      acceptsRelease(channel, { tag_name: 'nightly-100', prerelease: true })
    ).toBe(false);
  }
  expect(
    acceptsRelease('stable', { tag_name: 'v4.3.1', prerelease: false })
  ).toBe(true);
  expect(
    acceptsRelease('stable', { tag_name: 'v4.4.0', prerelease: true })
  ).toBe(false);
  expect(
    acceptsRelease('unstable', { tag_name: 'v4.4.0', prerelease: true })
  ).toBe(true);
});

test('same-base nightly setup updates and unchanged setup does not', () => {
  expect(
    shouldUpdateSetup('2.2.1-nightly.100', '2.2.1-nightly.101', 'nightly')
  ).toBe(true);
  expect(
    shouldUpdateSetup('2.2.1-nightly.100', '2.2.1-nightly.100', 'nightly')
  ).toBe(false);
  expect(
    shouldUpdateSetup('2.2.1-nightly.101', '2.2.1-nightly.100', 'nightly')
  ).toBe(false);
  expect(shouldUpdateSetup('2.2.1-nightly.101', '2.2.0', 'stable')).toBe(true);
});

test('a stale channel response cannot downgrade a newer nightly application', () => {
  expect(shouldUpdateApplication('nightly-101', 'nightly-100', 'nightly')).toBe(false);
  expect(shouldUpdateApplication('nightly-100', 'nightly-101', 'nightly')).toBe(true);
  expect(shouldUpdateApplication('nightly-100', 'v4.3.1', 'stable')).toBe(true);
});

test('incomplete or foreign nightly manifests are rejected', () => {
  expect(() => parseNightlyManifest({ schema: 1 })).toThrow();
  const build = (names: string[]) => ({
    version: '2.2.1-nightly.100',
    tag: 'nightly-100',
    source: 'a'.repeat(40),
    assets: names
      .flatMap((name) => [name, `${name}.blockmap`])
      .map((name) => ({
        name,
        size: 100,
        sha256: 'a'.repeat(64),
        browser_download_url: `https://github.com/Nat3z/OpenGameInstaller/releases/download/nightly-100/${name}`,
      })),
  });
  const manifest = {
    schema: 1,
    source: 'a'.repeat(40),
    build: '100',
    publishedAt: '2026-09-11T00:00:00Z',
    packages: {},
    application: build([
      'OpenGameInstaller-Portable.zip',
      'OpenGameInstaller-linux-pt.AppImage',
    ]),
    updater: build([
      'OpenGameInstaller-Setup.exe',
      'OpenGameInstaller-Setup.AppImage',
    ]),
  };
  expect(parseNightlyManifest(manifest).build).toBe('100');
  manifest.updater.assets[0]!.browser_download_url =
    'https://example.com/installer.exe';
  expect(() => parseNightlyManifest(manifest)).toThrow();
});
