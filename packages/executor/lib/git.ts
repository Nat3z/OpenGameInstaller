import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { AddonError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';

const logger = createLogger(LOGGER_PREFIXES.executor);

const runGitProcess = (
  cwd: string,
  args: string[],
  operation: string
): Effect.Effect<string, AddonError> =>
  Effect.gen(function* () {
    const filteredArgs = args.filter(Boolean);
    const child = yield* Effect.try({
      try: () =>
        spawn('git', filteredArgs, {
          cwd,
          stdio: 'pipe',
        }),
      catch: (cause) =>
        new AddonError({
          message: `Unable to start git ${operation}: ${String(cause)}`,
        }),
    });

    return yield* Effect.async<string, AddonError>((resume) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      child.stdout?.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        logger.sync.info(text);
      });
      child.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        logger.sync.error(text);
      });
      child.on('error', (cause) => {
        if (settled) return;
        settled = true;
        resume(
          Effect.fail(
            new AddonError({
              message: `Git ${operation} failed: ${String(cause)}`,
            })
          )
        );
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          resume(
            Effect.fail(
              new AddonError({
                message: `Git ${operation} failed with code ${code}: git ${filteredArgs.join(' ')}\n${stderr}`,
              })
            )
          );
        } else {
          // Git progress and "Already up to date" often land on stderr.
          resume(Effect.succeed((stdout + stderr).trim()));
        }
      });

      return Effect.sync(() => {
        if (!settled) child.kill();
      });
    });
  });

/** Effect-based git operations for an addon checkout. */
export class Git {
  constructor(private readonly addon: { readonly path: string }) {}

  private execGit(
    args: string[],
    operation: string
  ): Effect.Effect<string, AddonError> {
    return runGitProcess(this.addon.path, args, operation);
  }

  public clone(
    url: string,
    options: {
      readonly branch?: string;
      readonly depth?: number;
      readonly extraArgs?: string[];
    } = {}
  ): Effect.Effect<void, AddonError> {
    const target = this.addon.path;
    const args = ['clone'];
    if (options.depth != null) args.push('--depth', String(options.depth));
    if (options.branch != null) args.push('-b', options.branch);
    if (options.extraArgs?.length) args.push(...options.extraArgs);
    args.push(url, target);
    return runGitProcess(dirname(target), args, 'clone').pipe(Effect.asVoid);
  }

  public fetch(
    extraArgs: string[] = []
  ): Effect.Effect<{ readonly alreadyUpToDate: boolean }, AddonError> {
    return this.execGit(['fetch', ...extraArgs], 'fetch').pipe(
      Effect.map((result) => ({
        alreadyUpToDate:
          result.includes('Already up to date.') ||
          result.includes('Already up-to-date.'),
      }))
    );
  }

  public fetchRef(
    remote: string,
    ref: string
  ): Effect.Effect<void, AddonError | ValidationError> {
    if (!ref || ref.startsWith('-')) {
      return Effect.fail(
        new ValidationError({
          field: 'ref',
          message: `Refusing unsafe git ref: ${ref}`,
        })
      );
    }
    return this.fetch([remote, ref]).pipe(Effect.asVoid);
  }

  public resolveRemoteRef(
    remote: string,
    ref: string
  ): Effect.Effect<string, AddonError | ValidationError> {
    return Effect.gen(this, function* () {
      if (/^[0-9a-f]{4,40}$/i.test(ref)) {
        const localCommit = yield* Effect.either(this.resolveRef(ref));
        if (localCommit._tag === 'Right') return localCommit.right;
      }

      yield* this.fetchRef(remote, ref);
      return yield* this.resolveRef('FETCH_HEAD');
    });
  }

  public getCurrentBranch(): Effect.Effect<string | undefined, AddonError> {
    return this.execGit(
      ['branch', '--show-current'],
      'get current branch'
    ).pipe(Effect.map((branch) => branch || undefined));
  }

  public switchToRemoteDefaultBranch(
    remote: string
  ): Effect.Effect<string, AddonError | ValidationError> {
    return Effect.gen(this, function* () {
      if (!remote || remote.startsWith('-')) {
        return yield* Effect.fail(
          new ValidationError({
            field: 'remote',
            message: `Refusing unsafe git remote: ${remote}`,
          })
        );
      }

      yield* this.fetch([remote]);
      const trackingBranch = yield* this.execGit(
        ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`],
        `resolve ${remote} default branch`
      );
      const prefix = `${remote}/`;
      if (!trackingBranch.startsWith(prefix)) {
        return yield* Effect.fail(
          new ValidationError({
            field: 'remote',
            message: `Unexpected default branch for ${remote}: ${trackingBranch}`,
          })
        );
      }

      yield* this.switchBranch(trackingBranch.slice(prefix.length));
      yield* this.pull();
      return yield* this.getCurrentHash();
    });
  }

  public pull(
    options: { readonly force?: boolean } = {}
  ): Effect.Effect<void, AddonError> {
    const args = ['pull'];
    if (options.force) args.push('--force');
    return this.execGit(args, 'pull').pipe(Effect.asVoid);
  }

  public switchBranch(branch: string): Effect.Effect<void, AddonError> {
    return this.execGit(['switch', branch], `switch to branch ${branch}`).pipe(
      Effect.asVoid
    );
  }

  public createBranch(
    branch: string,
    startPoint?: string
  ): Effect.Effect<void, AddonError> {
    const args = ['switch', '-c', branch];
    if (startPoint) args.push(startPoint);
    return this.execGit(args, `create branch ${branch}`).pipe(Effect.asVoid);
  }

  public checkoutCommit(
    hash: string,
    options: { readonly fetchFirst?: boolean } = {}
  ): Effect.Effect<void, AddonError | ValidationError> {
    return Effect.gen(this, function* () {
      if (!hash || hash.startsWith('-')) {
        return yield* Effect.fail(
          new ValidationError({
            field: 'hash',
            message: `Refusing unsafe git ref: ${hash}`,
          })
        );
      }
      if (options.fetchFirst) yield* this.fetch();
      yield* this.execGit(
        ['switch', '--detach', '--', hash],
        `checkout commit ${hash}`
      );
    });
  }

  public getCurrentHash(): Effect.Effect<string, AddonError> {
    return this.execGit(['rev-parse', 'HEAD'], 'get commit hash');
  }

  public resolveRef(
    ref: string
  ): Effect.Effect<string, AddonError | ValidationError> {
    if (!ref || ref.startsWith('-')) {
      return Effect.fail(
        new ValidationError({
          field: 'ref',
          message: `Refusing unsafe git ref: ${ref}`,
        })
      );
    }
    return this.execGit(
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      `resolve ref ${ref}`
    );
  }

  public resetHard(ref: string): Effect.Effect<void, AddonError> {
    return this.execGit(['reset', '--hard', ref], `reset --hard ${ref}`).pipe(
      Effect.asVoid
    );
  }
}
