import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { Effect } from 'effect';
import {
  findManifests,
  MANIFEST_FILE,
  readManifest,
  writeManifests,
} from '../src/electron/lib/library-manifest.js';

const game = (appID: number, cwd: string): LibraryInfo => ({
  appID,
  name: `Game ${appID}`,
  version: '1',
  cwd,
  launchExecutable: join(cwd, 'bin', 'game.exe'),
  capsuleImage: '',
  coverImage: '',
  storefront: 'steam',
  addonsource: 'test',
  umu: {
    umuId: `umu:${appID}`,
    winePrefixPath: '/prefixes/umu-1',
    steamShortcutId: 42,
  },
});

describe('library manifests', () => {
  test('a game moved to another drive is found with paths rebased', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-manifest-'));
    const before = join(root, 'sd-a', 'Game');
    fs.mkdirSync(before, { recursive: true });
    await Effect.runPromise(writeManifests(Effect.succeed([game(1, before)])));

    const after = join(root, 'sd-b', 'Game');
    fs.mkdirSync(join(root, 'sd-b'));
    fs.renameSync(before, after);
    const [found] = await Effect.runPromise(findManifests([root]));

    expect(found.path).toBe(after);
    expect(found.game.cwd).toBe(after);
    expect(found.game.launchExecutable).toBe(join(after, 'bin', 'game.exe'));
    // Machine-specific state stays out of the manifest.
    expect(found.game.umu).toEqual({ umuId: 'umu:1' });
  });

  test('a folder that becomes shared loses its manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogi-manifest-'));
    const first = game(1, root);
    await Effect.runPromise(writeManifests(Effect.succeed([first])));
    expect(await Effect.runPromise(readManifest(root))).not.toBeNull();

    const nested = game(2, join(root, 'nested'));
    fs.mkdirSync(nested.cwd);
    await Effect.runPromise(writeManifests(Effect.succeed([first, nested]), 2));
    expect(fs.existsSync(join(root, MANIFEST_FILE))).toBe(false);
    expect(fs.existsSync(join(nested.cwd, MANIFEST_FILE))).toBe(false);
  });
});
