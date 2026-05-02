import { Addon } from './addon';
import { spawn } from 'child_process';
import { dirname } from 'path';

function pipeGitStreams(child: ReturnType<typeof spawn>): void {
  child.stdout?.on('data', (data) => {
    console.log(data.toString());
  });
  child.stderr?.on('data', (data) => {
    console.error(data.toString());
  });
}

function runGitProcess(
  cwd: string,
  args: string[],
  operation: string
): Promise<void> {
  const child = spawn('git', args.filter(Boolean), {
    cwd,
    stdio: 'pipe',
  });
  pipeGitStreams(child);

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Git ${operation} failed with code ${code}: git ${args.join(' ')}`
          )
        );
        return;
      }
      resolve();
    });
  });
}

export class Git {
  constructor(private readonly addon: Addon) {}

  private execGit(args: string[], operation: string): Promise<void> {
    return runGitProcess(this.addon.config.path, args, operation);
  }

  /**
   * Clone `url` into {@link Addon.config.path} (`git clone ... <path>`).
   * Parent of the addon path must exist; the clone target must not already exist as a repo root.
   */
  public clone(
    url: string,
    options: { branch?: string; depth?: number; extraArgs?: string[] } = {}
  ): Promise<void> {
    const target = this.addon.config.path;
    const args = ['clone'];
    if (options.depth != null) {
      args.push('--depth', String(options.depth));
    }
    if (options.branch != null) {
      args.push('-b', options.branch);
    }
    if (options.extraArgs?.length) {
      args.push(...options.extraArgs);
    }
    args.push(url, target);
    return runGitProcess(dirname(target), args, 'clone');
  }

  /** `git fetch` with optional extra arguments (e.g. `['origin', 'main']`). */
  public fetch(extraArgs: string[] = []): Promise<void> {
    return this.execGit(['fetch', ...extraArgs], 'fetch');
  }

  /**
   * Fetch a specific ref from a remote without updating HEAD.
   * Example: `fetchRef('origin', 'feature/x')`
   */
  public fetchRef(remote: string, ref: string): Promise<void> {
    return this.fetch([remote, ref]);
  }

  public pull(options: { force?: boolean } = {}): Promise<void> {
    const args = ['pull'];
    if (options.force) {
      args.push('--force');
    }
    return this.execGit(args, 'pull');
  }

  /**
   * Switch to an existing branch (`git switch <branch>`).
   */
  public switchBranch(branch: string): Promise<void> {
    return this.execGit(['switch', branch], `switch to branch ${branch}`);
  }

  /**
   * Create and switch to a new branch from the current HEAD (`git switch -c <branch>`).
   */
  public createBranch(branch: string, startPoint?: string): Promise<void> {
    const args = ['switch', '-c', branch];
    if (startPoint) {
      args.push(startPoint);
    }
    return this.execGit(args, `create branch ${branch}`);
  }

  /**
   * Pin the working tree to an exact commit (detached HEAD).
   * Fetches first when `fetchFirst` is true so the hash exists locally.
   */
  public async checkoutCommit(
    hash: string,
    options: { fetchFirst?: boolean } = {}
  ): Promise<void> {
    if (options.fetchFirst) {
      await this.fetch();
    }
    return this.execGit(
      ['switch', '--detach', hash],
      `checkout commit ${hash}`
    );
  }

  /**
   * Move the current branch to `ref` and match index/worktree (`git reset --hard <ref>`).
   * Use for pinning a branch tip to a specific commit after fetch.
   */
  public resetHard(ref: string): Promise<void> {
    return this.execGit(['reset', '--hard', ref], `reset --hard ${ref}`);
  }
}
