import { describe, expect, test } from 'bun:test';
import { homedir } from 'os';
import { join, sep } from 'path';
import {
  appMetadataSubtrees,
  type DeleteGuardRoots,
  filesystemRoot,
  isProtectedDeletePath,
  sharesDirectoryWithOtherGames,
  systemSubtrees,
} from './delete-guards';

const dataDir = '/data/ogi';
const roots = (): DeleteGuardRoots => ({
  exact: [filesystemRoot(), homedir(), dataDir],
  subtrees: [...appMetadataSubtrees(dataDir), ...systemSubtrees()],
});

describe('isProtectedDeletePath', () => {
  test('protects the filesystem root exactly and system subtrees by containment', () => {
    expect(isProtectedDeletePath('/', roots())).toBe(true);
    expect(isProtectedDeletePath('/etc', roots())).toBe(true);
    expect(isProtectedDeletePath('/usr/share', roots())).toBe(true);
    // Root containment must not silently match everything via an empty prefix
    expect(
      isProtectedDeletePath('/games/MyGame', { exact: [], subtrees: ['/'] })
    ).toBe(true);
  });

  test('protects the home directory itself but not its children', () => {
    expect(isProtectedDeletePath(homedir(), roots())).toBe(true);
    expect(
      isProtectedDeletePath(join(homedir(), 'Games', 'MyGame'), roots())
    ).toBe(false);
  });

  test('protects the data dir itself but keeps game installs deletable', () => {
    expect(isProtectedDeletePath(dataDir, roots())).toBe(true);
    expect(isProtectedDeletePath(join(dataDir, 'downloads'), roots())).toBe(
      false
    );
    expect(
      isProtectedDeletePath(join(dataDir, 'downloads', 'MyGame'), roots())
    ).toBe(false);
  });

  test('protects metadata subtrees by containment', () => {
    for (const subtree of appMetadataSubtrees(dataDir)) {
      expect(isProtectedDeletePath(subtree, roots())).toBe(true);
      expect(isProtectedDeletePath(join(subtree, 'file.json'), roots())).toBe(
        true
      );
    }
  });
});

describe('sharesDirectoryWithOtherGames', () => {
  const others = [
    { appID: 1, cwd: '/games/alpha' },
    { appID: 2, cwd: '/games/beta/nested' },
    { appID: 3 },
  ];

  test('detects exact, parent, and child overlaps with other games', () => {
    expect(sharesDirectoryWithOtherGames(9, '/games/alpha', others)).toBe(true);
    expect(sharesDirectoryWithOtherGames(9, '/games', others)).toBe(true);
    expect(
      sharesDirectoryWithOtherGames(9, '/games/beta/nested/child', others)
    ).toBe(true);
  });

  test('allows unrelated directories and ignores the removed game itself', () => {
    expect(sharesDirectoryWithOtherGames(9, '/games/gamma', others)).toBe(
      false
    );
    // Removing game 1 from its own directory is not an overlap with itself
    expect(
      sharesDirectoryWithOtherGames(1, join('/games/alpha' + sep, 'sub'), [
        { appID: 1, cwd: '/games/alpha' },
      ])
    ).toBe(false);
  });

  test('ignores other games without a cwd', () => {
    expect(sharesDirectoryWithOtherGames(9, '/somewhere', [{ appID: 3 }])).toBe(
      false
    );
  });
});
