import { Data, Effect } from 'effect';

export type CommandResult = { stdout: string; stderr: string };

export class GitSyncError extends Data.TaggedError('GitSyncError')<{
  readonly message: string;
  readonly operation:
    | 'fetch'
    | 'resolve-head'
    | 'checkout'
    | 'rebase'
    | 'stash';
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
  getRepoHeadSha: (repoDir: string) => Effect.Effect<string, GitSyncError>
): Effect.Effect<BleedingEdgeSyncResult, GitSyncError> {
  const targetBranch = branch || defaultBranch;
  const remoteBranch = `refs/remotes/origin/${targetBranch}`;

  return Effect.gen(function* () {
    yield* withOperation(
      'fetch',
      runCommand(
        'git',
        ['fetch', '--prune', '--tags', 'origin', ALL_ORIGIN_HEADS_REFSPEC],
        { cwd: repoDir }
      )
    );
    const beforeSyncSha = yield* withOperation(
      'resolve-head',
      getRepoHeadSha(repoDir)
    );
    const remoteBranchResult = yield* Effect.either(
      runCommand('git', ['rev-parse', '--verify', remoteBranch], {
        cwd: repoDir,
      })
    );
    if (remoteBranchResult._tag === 'Left') {
      return yield* withOperation(
        'checkout',
        Effect.fail(remoteBranchResult.left)
      );
    }
    const checkoutExisting = yield* Effect.either(
      runCommand('git', ['checkout', targetBranch], { cwd: repoDir })
    );
    const checkoutResult =
      checkoutExisting._tag === 'Right'
        ? checkoutExisting
        : yield* Effect.either(
            runCommand(
              'git',
              ['checkout', '--track', '-b', targetBranch, remoteBranch],
              { cwd: repoDir }
            )
          );
    const rebaseResult =
      checkoutResult._tag === 'Right'
        ? yield* Effect.either(
            runCommand('git', ['rebase', remoteBranch], { cwd: repoDir })
          )
        : checkoutResult;

    if (rebaseResult._tag === 'Left') {
      yield* runCommand('git', ['rebase', '--abort'], {
        cwd: repoDir,
      }).pipe(Effect.ignore);
      yield* withOperation(
        'stash',
        runCommand(
          'git',
          [
            'stash',
            'push',
            '--include-untracked',
            '-m',
            'OpenGameInstaller updater recovery',
          ],
          { cwd: repoDir }
        )
      );
      // Rebase could not safely preserve the cache. Keep dirty files in the
      // stash, then force-align the updater branch to the fetched remote.
      yield* withOperation(
        'checkout',
        runCommand(
          'git',
          ['checkout', '--force', '-B', targetBranch, remoteBranch],
          { cwd: repoDir }
        )
      );
    }
    const afterSyncSha = yield* withOperation(
      'resolve-head',
      getRepoHeadSha(repoDir)
    );

    return {
      beforeSyncSha,
      afterSyncSha,
      syncWasNoop: beforeSyncSha === afterSyncSha,
    };
  });
}
