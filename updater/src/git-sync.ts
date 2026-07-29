export type CommandResult = { stdout: string; stderr: string };

export type GitCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string }
) => Promise<CommandResult>;

export type BleedingEdgeSyncResult = {
  beforeSyncSha: string;
  afterSyncSha: string;
  syncWasNoop: boolean;
};

const ALL_ORIGIN_HEADS_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

export async function syncBleedingEdgeRepo(
  repoDir: string,
  branch: string,
  defaultBranch: string,
  runCommand: GitCommandRunner,
  getRepoHeadSha: (repoDir: string) => Promise<string>
): Promise<BleedingEdgeSyncResult> {
  const targetBranch = branch || defaultBranch;
  await runCommand(
    'git',
    ['fetch', '--prune', '--tags', 'origin', ALL_ORIGIN_HEADS_REFSPEC],
    { cwd: repoDir }
  );
  const beforeSyncSha = await getRepoHeadSha(repoDir);
  // This is an updater-owned build cache, so the fetched remote branch is the
  // source of truth even when a feature branch has been force-pushed.
  await runCommand(
    'git',
    [
      'checkout',
      '--force',
      '-B',
      targetBranch,
      `refs/remotes/origin/${targetBranch}`,
    ],
    { cwd: repoDir }
  );
  const afterSyncSha = await getRepoHeadSha(repoDir);
  return {
    beforeSyncSha,
    afterSyncSha,
    syncWasNoop: beforeSyncSha === afterSyncSha,
  };
}
