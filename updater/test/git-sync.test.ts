import { afterEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
