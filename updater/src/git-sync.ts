import { Data, Effect } from 'effect';

export type CommandResult = { stdout: string; stderr: string };

export class GitSyncError extends Data.TaggedError('GitSyncError')<{
  readonly message: string;
  readonly operation: 'fetch' | 'resolve-head' | 'checkout';
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
    // This is an updater-owned build cache, so the fetched remote branch is the
    // source of truth even when a feature branch has been force-pushed.
    yield* withOperation(
      'checkout',
      runCommand(
        'git',
        [
          'checkout',
          '--force',
          '-B',
          targetBranch,
          `refs/remotes/origin/${targetBranch}`,
        ],
        { cwd: repoDir }
      )
    );
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
