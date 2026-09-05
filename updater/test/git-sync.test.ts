import { afterEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Effect } from 'effect';
import {
  type CommandResult,
  GitSyncError,
  syncBleedingEdgeRepo,
} from '../src/git-sync.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<CommandResult> {
  const result = await execFileAsync('git', args, { cwd });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function getHeadSha(repoDir: string): Effect.Effect<string, GitSyncError> {
  return Effect.tryPromise({
    try: async () => (await git(repoDir, 'rev-parse', 'HEAD')).stdout.trim(),
    catch: (cause) =>
      new GitSyncError({
        message: String(cause),
        operation: 'resolve-head',
        cause,
      }),
  });
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string }
): Effect.Effect<CommandResult, GitSyncError> {
  return Effect.tryPromise({
    try: () => {
      if (command !== 'git') {
        throw new Error(`Unexpected command: ${command}`);
      }
      return git(options.cwd, ...args);
    },
    catch: (cause) =>
      new GitSyncError({
        message: String(cause),
        operation: 'fetch',
        cause,
      }),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

test('synchronizes a cached branch after the remote branch is force-pushed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ogi-git-sync-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const client = path.join(root, 'client');
  const branch = 't3code/fix-parallel-limit-downloads';

  await git(root, 'init', '--bare', remote);
  await git(root, 'init', '-b', 'main', seed);
  await git(seed, 'config', 'user.email', 'updater-test@example.invalid');
  await git(seed, 'config', 'user.name', 'updater-test');
  await writeFile(path.join(seed, 'file.txt'), 'base\n');
  await git(seed, 'add', 'file.txt');
  await git(seed, 'commit', '-m', 'base');
  await git(seed, 'checkout', '-b', branch);
  await writeFile(path.join(seed, 'file.txt'), 'old branch\n');
  await git(seed, 'commit', '-am', 'old branch');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', 'origin', 'main', branch);
  await git(root, 'clone', '--branch', branch, remote, client);

  await git(seed, 'checkout', 'main');
  await git(seed, 'checkout', '-B', branch, 'main');
  await writeFile(path.join(seed, 'file.txt'), 'rewritten branch\n');
  await git(seed, 'add', 'file.txt');
  await git(seed, 'commit', '-m', 'rewritten branch');
  await git(seed, 'push', '--force', 'origin', branch);
  const remoteSha = await Effect.runPromise(getHeadSha(seed));

  const result = await Effect.runPromise(
    syncBleedingEdgeRepo(client, branch, 'main', runCommand, getHeadSha)
  );

  expect(result.afterSyncSha).toBe(remoteSha);
  expect(await Effect.runPromise(getHeadSha(client))).toBe(remoteSha);
});

test('builds the remote revision while preserving local commits on their branch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ogi-git-sync-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const client = path.join(root, 'client');

  await git(root, 'init', '--bare', remote);
  await git(root, 'init', '-b', 'main', seed);
  await git(seed, 'config', 'user.email', 'updater-test@example.invalid');
  await git(seed, 'config', 'user.name', 'updater-test');
  await writeFile(path.join(seed, 'base.txt'), 'base\n');
  await git(seed, 'add', 'base.txt');
  await git(seed, 'commit', '-m', 'base');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', 'origin', 'main');
  await git(root, 'clone', '--branch', 'main', remote, client);
  await git(client, 'config', 'user.email', 'updater-test@example.invalid');
  await git(client, 'config', 'user.name', 'updater-test');

  await writeFile(path.join(client, 'local.txt'), 'local\n');
  await git(client, 'add', 'local.txt');
  await git(client, 'commit', '-m', 'local change');
  await writeFile(path.join(seed, 'remote.txt'), 'remote\n');
  await git(seed, 'add', 'remote.txt');
  await git(seed, 'commit', '-m', 'remote change');
  await git(seed, 'push', 'origin', 'main');
  const remoteSha = await Effect.runPromise(getHeadSha(seed));

  const result = await Effect.runPromise(
    syncBleedingEdgeRepo(client, 'main', 'main', runCommand, getHeadSha)
  );

  expect(result.afterSyncSha).toBe(remoteSha);
  expect(
    (await git(client, 'merge-base', 'HEAD', `origin/main`)).stdout.trim()
  ).toBe(remoteSha);
  expect((await git(client, 'show', 'main:local.txt')).stdout).toBe('local\n');
});

test('stashes dirty files without requiring user Git identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ogi-git-sync-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const client = path.join(root, 'client');

  await git(root, 'init', '--bare', remote);
  await git(root, 'init', '-b', 'main', seed);
  await git(seed, 'config', 'user.email', 'updater-test@example.invalid');
  await git(seed, 'config', 'user.name', 'updater-test');
  await writeFile(path.join(seed, 'file.txt'), 'base\n');
  await git(seed, 'add', 'file.txt');
  await git(seed, 'commit', '-m', 'base');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', 'origin', 'main');
  await git(root, 'clone', '--branch', 'main', remote, client);

  await writeFile(path.join(client, 'file.txt'), 'dirty local change\n');
  await writeFile(path.join(seed, 'file.txt'), 'remote change\n');
  await git(seed, 'commit', '-am', 'remote change');
  await git(seed, 'push', 'origin', 'main');
  const remoteSha = await Effect.runPromise(getHeadSha(seed));

  const result = await Effect.runPromise(
    syncBleedingEdgeRepo(client, 'main', 'main', runCommand, getHeadSha)
  );

  expect(result.afterSyncSha).toBe(remoteSha);
  expect(
    (await git(client, 'stash', 'show', '-p', 'stash@{0}')).stdout
  ).toContain('dirty local change');
});

test('returns a missing remote branch error without starting recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ogi-git-sync-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const client = path.join(root, 'client');
  const commands: string[][] = [];

  await git(root, 'init', '--bare', remote);
  await git(root, 'init', '-b', 'main', seed);
  await git(seed, 'config', 'user.email', 'updater-test@example.invalid');
  await git(seed, 'config', 'user.name', 'updater-test');
  await writeFile(path.join(seed, 'file.txt'), 'base\n');
  await git(seed, 'add', 'file.txt');
  await git(seed, 'commit', '-m', 'base');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', 'origin', 'main');
  await git(root, 'clone', '--branch', 'main', remote, client);

  const error = await Effect.runPromise(
    Effect.flip(
      syncBleedingEdgeRepo(
        client,
        'missing',
        'main',
        (command, args, options) => {
          commands.push(args);
          return runCommand(command, args, options);
        },
        getHeadSha
      )
    )
  );

  expect(error.operation).toBe('checkout');
  expect(commands.some((args) => args.includes('stash'))).toBe(false);
  expect(commands.some((args) => args.includes('--force'))).toBe(false);
});

test('recovers a dirty detached cache when the target branch exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ogi-git-sync-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const client = path.join(root, 'client');
  const commands: string[][] = [];

  await git(root, 'init', '--bare', remote);
  await git(root, 'init', '-b', 'main', seed);
  await git(seed, 'config', 'user.email', 'updater-test@example.invalid');
  await git(seed, 'config', 'user.name', 'updater-test');
  await writeFile(path.join(seed, 'file.txt'), 'base\n');
  await git(seed, 'add', 'file.txt');
  await git(seed, 'commit', '-m', 'base');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', 'origin', 'main');
  await git(root, 'clone', '--branch', 'main', remote, client);
  await git(client, 'config', 'user.email', 'updater-test@example.invalid');
  await git(client, 'config', 'user.name', 'updater-test');

  await git(client, 'checkout', '--detach');
  await writeFile(path.join(client, 'file.txt'), 'detached commit\n');
  await git(client, 'commit', '-am', 'detached commit');
  await writeFile(path.join(client, 'file.txt'), 'dirty detached change\n');
  await writeFile(path.join(seed, 'file.txt'), 'remote change\n');
  await git(seed, 'commit', '-am', 'remote change');
  await git(seed, 'push', 'origin', 'main');
  const remoteSha = await Effect.runPromise(getHeadSha(seed));

  const result = await Effect.runPromise(
    syncBleedingEdgeRepo(
      client,
      'main',
      'main',
      (command, args, options) => {
        commands.push(args);
        return runCommand(command, args, options);
      },
      getHeadSha
    )
  );

  expect(result.afterSyncSha).toBe(remoteSha);
  expect(commands.some((args) => args.includes('stash'))).toBe(true);
  expect(commands.some((args) => args.includes('--detach'))).toBe(true);
  expect(
    (await git(client, 'stash', 'show', '-p', 'stash@{0}')).stdout
  ).toContain('dirty detached change');
});

async function createRepository(): Promise<{
  root: string;
  remote: string;
  seed: string;
  client: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'ogi-git-sync-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const client = path.join(root, 'client');
  await git(root, 'init', '--bare', remote);
  await git(root, 'init', '-b', 'main', seed);
  await git(seed, 'config', 'user.email', 'updater-test@example.invalid');
  await git(seed, 'config', 'user.name', 'updater-test');
  await writeFile(path.join(seed, 'base.txt'), 'base\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'base');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', 'origin', 'main');
  return { root, remote, seed, client };
}

test('does not resurrect a non-conflicting commit removed by a force push', async () => {
  const { root, remote, seed, client } = await createRepository();
  const base = await Effect.runPromise(getHeadSha(seed));
  await writeFile(path.join(seed, 'removed.txt'), 'removed upstream\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'removed commit');
  await git(seed, 'push', 'origin', 'main');
  await git(root, 'clone', '--branch', 'main', remote, client);
  await git(seed, 'checkout', '--detach', base);
  await writeFile(path.join(seed, 'new.txt'), 'new upstream\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'replacement');
  await git(seed, 'push', '--force', 'origin', 'HEAD:main');
  const result = await Effect.runPromise(
    syncBleedingEdgeRepo(client, 'main', 'main', runCommand, getHeadSha)
  );
  expect(result.afterSyncSha).toBe(await Effect.runPromise(getHeadSha(seed)));
  expect(
    (await git(client, 'ls-tree', '--name-only', 'HEAD')).stdout
  ).not.toContain('removed.txt');
});

test('rejects a pinned commit that a force push removed from the remote', async () => {
  const { root, remote, seed, client } = await createRepository();
  const base = await Effect.runPromise(getHeadSha(seed));
  await writeFile(path.join(seed, 'removed.txt'), 'removed upstream\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'removed commit');
  await git(seed, 'push', 'origin', 'main');
  const removed = await Effect.runPromise(getHeadSha(seed));
  await git(root, 'clone', '--branch', 'main', remote, client);
  await git(seed, 'checkout', '--detach', base);
  await writeFile(path.join(seed, 'new.txt'), 'new upstream\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'replacement');
  await git(seed, 'push', '--force', 'origin', 'HEAD:main');
  const error = await Effect.runPromise(
    Effect.flip(
      syncBleedingEdgeRepo(
        client,
        'main',
        'main',
        runCommand,
        getHeadSha,
        removed
      )
    )
  );
  expect(error.operation).toBe('checkout');
  expect(error.message).toContain(removed);
});

test('unshallows old picker caches and builds an older pinned commit', async () => {
  const { root, remote, seed, client } = await createRepository();
  const base = await Effect.runPromise(getHeadSha(seed));
  await writeFile(path.join(seed, 'base.txt'), 'new\n');
  await git(seed, 'commit', '-am', 'new');
  await git(seed, 'push', 'origin', 'main');
  await git(
    root,
    'clone',
    '--depth',
    '1',
    '--branch',
    'main',
    pathToFileURL(remote).href,
    client
  );
  const result = await Effect.runPromise(
    syncBleedingEdgeRepo(client, 'main', 'main', runCommand, getHeadSha, base)
  );
  expect(result.afterSyncSha).toBe(base);
  expect(
    (await git(client, 'rev-parse', '--is-shallow-repository')).stdout.trim()
  ).toBe('false');
});

test('resolves branch overrides to the remote and accepts moved annotated tags', async () => {
  const { root, remote, seed, client } = await createRepository();
  await git(seed, 'tag', '-a', 'preview', '-m', 'old preview');
  await git(seed, 'push', 'origin', 'preview');
  await git(root, 'clone', '--branch', 'main', remote, client);
  await writeFile(path.join(seed, 'base.txt'), 'new\n');
  await git(seed, 'commit', '-am', 'new');
  await git(seed, 'tag', '-f', '-a', 'preview', '-m', 'new preview');
  await git(seed, 'push', '--force', 'origin', 'main', 'preview');
  const head = await Effect.runPromise(getHeadSha(seed));
  for (const ref of [
    'main',
    'refs/heads/main',
    'refs/remotes/origin/main',
    'preview',
    'refs/tags/preview',
  ]) {
    const result = await Effect.runPromise(
      syncBleedingEdgeRepo(client, 'main', 'main', runCommand, getHeadSha, ref)
    );
    expect(result.afterSyncSha).toBe(head);
  }
});

test('rejects a branch override whose upstream was deleted but survives locally', async () => {
  const { root, remote, seed, client } = await createRepository();
  await git(seed, 'switch', '-c', 'feature');
  await writeFile(path.join(seed, 'feature.txt'), 'feature\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'feature');
  await git(seed, 'push', 'origin', 'feature');
  await git(root, 'clone', '--branch', 'main', remote, client);
  await git(client, 'switch', '-c', 'feature', '--track', 'origin/feature');
  await git(client, 'switch', 'main');
  await git(seed, 'switch', 'main');
  await git(seed, 'merge', '--ff-only', 'feature');
  await git(seed, 'push', 'origin', 'main');
  await git(seed, 'push', 'origin', '--delete', 'feature');
  const error = await Effect.runPromise(
    Effect.flip(
      syncBleedingEdgeRepo(
        client,
        'main',
        'main',
        runCommand,
        getHeadSha,
        'feature'
      )
    )
  );
  expect(error.operation).toBe('checkout');
  expect(error.message).toContain('feature');
});
