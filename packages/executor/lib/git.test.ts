import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { Git } from './git.ts';

const temporaryDirectories: string[] = [];

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

async function createRepository(): Promise<{
  directory: string;
  remotePath: string;
  sourcePath: string;
  clonePath: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'ogi-git-ref-'));
  temporaryDirectories.push(directory);
  const remotePath = join(directory, 'remote.git');
  const sourcePath = join(directory, 'source');
  const clonePath = join(directory, 'clone');

  runGit(directory, ['init', '--bare', remotePath]);
  runGit(directory, ['init', sourcePath]);
  runGit(sourcePath, ['config', 'user.name', 'OpenGameInstaller Tests']);
  runGit(sourcePath, ['config', 'user.email', 'tests@opengameinstaller.dev']);
  await Bun.write(join(sourcePath, 'addon.json'), '{}');
  runGit(sourcePath, ['add', 'addon.json']);
  runGit(sourcePath, ['commit', '-m', 'test addon']);
  runGit(sourcePath, ['remote', 'add', 'origin', remotePath]);
  runGit(sourcePath, ['push', 'origin', 'HEAD:main']);
  runGit(remotePath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  runGit(directory, ['clone', remotePath, clonePath]);

  return { directory, remotePath, sourcePath, clonePath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Git refs', () => {
  test('ignores Steam loader injection when parsing Git output', async () => {
    const { clonePath } = await createRepository();
    const expectedHash = runGit(clonePath, ['rev-parse', 'HEAD']);
    const originalLdPreload = process.env.LD_PRELOAD;

    process.env.LD_PRELOAD = '/tmp/ogi-missing-steam-runtime-library.so';
    try {
      const actualHash = await Effect.runPromise(
        new Git({ path: clonePath }).getCurrentHash()
      );

      expect(actualHash).toBe(expectedHash);
    } finally {
      if (originalLdPreload === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = originalLdPreload;
    }
  });

  test('resolves a locally available abbreviated commit without fetching it by name', async () => {
    const { remotePath, clonePath } = await createRepository();
    const fullHash = runGit(clonePath, ['rev-parse', 'HEAD']);
    const abbreviatedHash = fullHash.slice(0, 7);
    rmSync(remotePath, { recursive: true, force: true });

    const resolvedHash = await Effect.runPromise(
      new Git({ path: clonePath }).resolveRemoteRef('origin', abbreviatedHash)
    );

    expect(resolvedHash).toBe(fullHash);
  });

  test('returns a detached explicit ref checkout to the remote default branch', async () => {
    const { sourcePath, clonePath } = await createRepository();
    const mainHash = runGit(clonePath, ['rev-parse', 'HEAD']);
    runGit(sourcePath, ['switch', '-c', 'develop']);
    await Bun.write(join(sourcePath, 'addon.json'), '{"branch":"develop"}');
    runGit(sourcePath, ['add', 'addon.json']);
    runGit(sourcePath, ['commit', '-m', 'develop addon']);
    runGit(sourcePath, ['push', 'origin', 'develop']);

    const git = new Git({ path: clonePath });
    const developHash = await Effect.runPromise(
      git.resolveRemoteRef('origin', 'develop')
    );
    await Effect.runPromise(git.checkoutCommit(developHash));

    const restoredHash = await Effect.runPromise(
      git.switchToRemoteDefaultBranch('origin')
    );

    expect(restoredHash).toBe(mainHash);
    expect(await Effect.runPromise(git.getCurrentBranch())).toBe('main');
  });
});
