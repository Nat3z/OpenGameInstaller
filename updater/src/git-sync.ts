import { Data, Effect } from 'effect';
import { normalizeBranch } from './bleeding-edge-flow.js';

export type CommandResult = { stdout: string; stderr: string };

export class GitSyncError extends Data.TaggedError('GitSyncError')<{
  readonly message: string;
  readonly operation: 'fetch' | 'resolve-head' | 'checkout' | 'stash';
  readonly cause?: unknown;
}> {}

type GitCommandError = {
  readonly message: string;
  readonly cause?: unknown;
};

export type GitCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string }
) => Effect.Effect<CommandResult, GitCommandError>;

export type BleedingEdgeSyncResult = {
  beforeSyncSha: string;
  afterSyncSha: string;
  syncWasNoop: boolean;
};

const ALL_ORIGIN_HEADS_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

const withOperation = <A>(
  operation: GitSyncError['operation'],
  effect: Effect.Effect<A, GitCommandError>
): Effect.Effect<A, GitSyncError> =>
  Effect.mapError(
    effect,
    (error) =>
      new GitSyncError({
        message: error.message,
        operation,
        cause: error.cause ?? error,
      })
  );

export function syncBleedingEdgeRepo(
  repoDir: string,
  branch: string,
  defaultBranch: string,
  runCommand: GitCommandRunner,
  getRepoHeadSha: (repoDir: string) => Effect.Effect<string, GitSyncError>,
  commit = ''
): Effect.Effect<BleedingEdgeSyncResult, GitSyncError> {
  const targetBranch = normalizeBranch(branch) || defaultBranch;
  const remoteBranch = `refs/remotes/origin/${targetBranch}`;

  return Effect.gen(function* () {
    yield* withOperation(
      'checkout',
      runCommand('git', ['check-ref-format', `refs/heads/${targetBranch}`], {
        cwd: repoDir,
      })
    );
    const shallow = yield* withOperation(
      'fetch',
      runCommand('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: repoDir,
      })
    );
    yield* withOperation(
      'fetch',
      runCommand(
        'git',
        [
          'fetch',
          '--prune',
          ...(shallow.stdout.trim() === 'true' ? ['--unshallow'] : []),
          'origin',
          ALL_ORIGIN_HEADS_REFSPEC,
          '+refs/tags/*:refs/tags/*',
        ],
        { cwd: repoDir }
      )
    );
    const beforeSyncSha = yield* getRepoHeadSha(repoDir);
    // Resolve branch names against the fetched remote, never stale local branches.
    let revision = remoteBranch;
    if (commit) {
      const remoteCommit = yield* Effect.either(
        runCommand(
          'git',
          [
            'rev-parse',
            '--verify',
            '--end-of-options',
            `refs/remotes/origin/${normalizeBranch(commit)}^{commit}`,
          ],
          { cwd: repoDir }
        )
      );
      revision =
        remoteCommit._tag === 'Right'
          ? remoteCommit.right.stdout.trim()
          : commit;
    }
    const resolved = yield* withOperation(
      'checkout',
      runCommand(
        'git',
        ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
        { cwd: repoDir }
      )
    );
    const targetSha = resolved.stdout.trim();
    // Refuse revisions that only survive locally after a force push or tag deletion.
    const reachable = yield* withOperation(
      'checkout',
      runCommand(
        'git',
        [
          'for-each-ref',
          '--count=1',
          `--contains=${targetSha}`,
          'refs/remotes/origin',
          'refs/tags',
        ],
        { cwd: repoDir }
      )
    );
    if (!reachable.stdout.trim()) {
      return yield* Effect.fail(
        new GitSyncError({
          message: `Revision ${targetSha} is no longer available from origin`,
          operation: 'checkout',
        })
      );
    }
    const status = yield* withOperation(
      'stash',
      runCommand('git', ['status', '--porcelain'], { cwd: repoDir })
    );
    if (status.stdout.trim()) {
      yield* withOperation(
        'stash',
        runCommand(
          'git',
          [
            '-c',
            'user.name=OpenGameInstaller updater',
            '-c',
            'user.email=updater@opengameinstaller.local',
            'stash',
            'push',
            '--include-untracked',
            '-m',
            'OpenGameInstaller updater recovery',
          ],
          { cwd: repoDir }
        )
      );
    }
    // This is a build cache. Rebasing can resurrect commits removed by a force push.
    // Detached checkout preserves local branches while building the exact selected revision.
    yield* withOperation(
      'checkout',
      runCommand('git', ['checkout', '--detach', targetSha], { cwd: repoDir })
    );
    const afterSyncSha = yield* getRepoHeadSha(repoDir);
    return {
      beforeSyncSha,
      afterSyncSha,
      syncWasNoop: beforeSyncSha === afterSyncSha,
    };
  });
}
