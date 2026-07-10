import { spawn } from 'child_process';
import { dirname } from 'path';
import { Addon } from './addon';

function runGitProcess(
  cwd: string,
  args: string[],
  operation: string
): Promise<string> {
  const child = spawn('git', args.filter(Boolean), {
    cwd,
    stdio: 'pipe',
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (data) => {
    const text = data.toString();
    stdout += text;
    console.log(text);
  });
  child.stderr?.on('data', (data) => {
    const text = data.toString();
    stderr += text;
    console.error(text);
  });

  return new Promise<string>((resolve, reject) => {
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
      // Include stderr: git progress / "Already up to date" often lands there.
      resolve((stdout + stderr).trim());
    });
  });
}

export class Git {
  constructor(private readonly addon: { path: string }) {}

  private async execGit(args: string[], operation: string): Promise<string> {
    return await runGitProcess(this.addon.path, args, operation);
  }

  /**
   * Clone `url` into {@link Addon.config.path} (`git clone ... <path>`).
   * Parent of the addon path must exist; the clone target must not already exist as a repo root.
   */
  public async clone(
    url: string,
    options: { branch?: string; depth?: number; extraArgs?: string[] } = {}
  ): Promise<void> {
    const target = this.addon.path;
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
    return void (await runGitProcess(dirname(target), args, 'clone'));
  }

  /** `git fetch` with optional extra arguments (e.g. `['origin', 'main']`). */
  public async fetch(
    extraArgs: string[] = []
  ): Promise<{ alreadyUpToDate: boolean }> {
    const result = await this.execGit(['fetch', ...extraArgs], 'fetch');
    return {
      alreadyUpToDate:
        result.includes('Already up to date.') ||
        result.includes('Already up-to-date.'),
    };
  }

  /**
   * Fetch a specific ref from a remote without updating HEAD.
   * Example: `fetchRef('origin', 'feature/x')`
   */
  public async fetchRef(remote: string, ref: string): Promise<void> {
    return void (await this.fetch([remote, ref]));
  }

  public async pull(options: { force?: boolean } = {}): Promise<void> {
    const args = ['pull'];
    if (options.force) {
      args.push('--force');
    }
    return void (await this.execGit(args, 'pull'));
  }

  /**
   * Switch to an existing branch (`git switch <branch>`).
   */
  public async switchBranch(branch: string): Promise<void> {
    return void (await this.execGit(
      ['switch', branch],
      `switch to branch ${branch}`
    ));
  }

  /**
   * Create and switch to a new branch from the current HEAD (`git switch -c <branch>`).
   */
  public async createBranch(
    branch: string,
    startPoint?: string
  ): Promise<void> {
    const args = ['switch', '-c', branch];
    if (startPoint) {
      args.push(startPoint);
    }
    return void (await this.execGit(args, `create branch ${branch}`));
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
    return void (await this.execGit(
      ['switch', '--detach', hash],
      `checkout commit ${hash}`
    ));
  }

  /**
   * Get the working tree commit hash.
   */
  public async getCurrentHash(): Promise<string> {
    return await this.execGit(['rev-parse', 'HEAD'], 'get commit hash');
  }

  /**
   * Move the current branch to `ref` and match index/worktree (`git reset --hard <ref>`).
   * Use for pinning a branch tip to a specific commit after fetch.
   */
  public async resetHard(ref: string): Promise<void> {
    return void (await this.execGit(
      ['reset', '--hard', ref],
      `reset --hard ${ref}`
    ));
  }
}
