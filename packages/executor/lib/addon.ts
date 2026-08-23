import type { ChildProcess } from 'node:child_process';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { AddonError, FileSystemError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Deferred, Effect, Exit, Schema, Scope } from 'effect';
import parseArgsStringToArgv from 'string-argv';
import { AddonSetup } from '@/addon-setup';
import { Git } from './git';

const logger = createLogger(LOGGER_PREFIXES.executor);

export const AddonFileConfigurationSchema = Schema.Struct({
  author: Schema.String,
  scripts: Schema.Struct({
    setup: Schema.optional(Schema.String),
    run: Schema.String,
    preSetup: Schema.optional(Schema.String),
    postSetup: Schema.optional(Schema.String),
  }),
});

export type AddonFileConfiguration = Schema.Schema.Type<
  typeof AddonFileConfigurationSchema
>;

export type AddonConfig = {
  readonly port: number;
  readonly secret: string;
  readonly path: string;
  readonly name: string;
  /** True when this session was launched for a specific game (Steam shortcut). */
  readonly gameSpecificLaunch?: boolean;
  scripts: AddonFileConfiguration['scripts'];
};

export type ScriptSpawnCommand = {
  readonly command: string;
  readonly args: string[];
};

type AddonLifecycleError = AddonError | FileSystemError | ValidationError;

/** Effect-based addon process lifecycle. */
export class Addon {
  public readonly setup: AddonSetup;
  private childProcess: ChildProcess | null = null;
  private processScope: Scope.CloseableScope | null = null;

  constructor(public readonly config: AddonConfig) {
    this.setup = new AddonSetup(config);
  }

  public static readonly Git = Git;
  public static readonly Setup = AddonSetup;

  public static getBunPath(): Effect.Effect<string, AddonError> {
    if (process.platform === 'win32') {
      return Effect.succeed(
        join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe')
      );
    }

    return Effect.try({
      try: () =>
        execFileSync('which', ['bun'], {
          encoding: 'utf-8',
          env: process.env,
        }).trim(),
      catch: () =>
        new AddonError({ message: 'Unable to find bun through which' }),
    }).pipe(
      Effect.filterOrFail(
        (path) => path.length > 0,
        () => new AddonError({ message: 'which returned an empty bun path' })
      ),
      Effect.catchAll(() =>
        Effect.succeed(join(process.env.HOME || '', '.bun', 'bin', 'bun'))
      )
    );
  }

  public static getEnvironmentWithBun(): Effect.Effect<
    NodeJS.ProcessEnv,
    AddonError
  > {
    return Addon.getBunPath().pipe(
      Effect.map((bunPath) => {
        const currentPath = process.env.PATH ?? process.env.Path;
        return {
          ...process.env,
          PATH: [dirname(bunPath), currentPath].filter(Boolean).join(delimiter),
        };
      })
    );
  }

  public static intoExecutor(
    fullCommand: string
  ): Effect.Effect<string, AddonError> {
    return Effect.gen(function* () {
      const bunPath = yield* Addon.getBunPath();
      return fullCommand.replace(/^(\.?[\\/]?bun(?:.exe)?)\b/, `"${bunPath}"`);
    });
  }

  public static getPowerShellExecutable(): string {
    return 'powershell.exe';
  }

  private static quoteWindowsShellArgument(value: string): string {
    return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
  }

  public static getScriptSpawnCommand(
    script: string,
    extraArgs: string[] = []
  ): Effect.Effect<ScriptSpawnCommand, AddonError | ValidationError> {
    return Effect.gen(function* () {
      if (process.platform === 'win32') {
        const scriptCommand = yield* Addon.intoExecutor(script);
        const command = [
          scriptCommand,
          ...extraArgs.map(Addon.quoteWindowsShellArgument),
        ].join(' ');
        return {
          command: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
          args: ['/d', '/s', '/c', command],
        };
      }

      const executableCommand = yield* Addon.intoExecutor(script);
      const parsed = yield* Effect.try({
        try: () => parseArgsStringToArgv(executableCommand),
        catch: (cause) =>
          new ValidationError({
            message: `Unable to parse addon command: ${String(cause)}`,
          }),
      });
      const [command, ...args] = parsed;
      if (!command) {
        return yield* Effect.fail(
          new ValidationError({ message: 'Addon command is empty' })
        );
      }
      return { command, args: [...args, ...extraArgs] };
    });
  }

  private spawnProcess(
    command: string,
    args: string[]
  ): Effect.Effect<ChildProcess, AddonError> {
    return Effect.try({
      try: () =>
        spawn(command, args, {
          cwd: this.config.path,
          // Flag game-specific launches so the addon SDK can expose it on connect
          env: {
            ...process.env,
            ...(this.config.gameSpecificLaunch ? { OGI_GAME_LAUNCH: '1' } : {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      catch: (cause) =>
        new AddonError({
          addonName: this.config.name,
          message: `Unable to start addon: ${String(cause)}`,
        }),
    });
  }

  private stopProcess(child: ChildProcess): Effect.Effect<void, AddonError> {
    const killChild = Effect.try({
      try: () => void child.kill(),
      catch: (cause) =>
        new AddonError({
          addonName: this.config.name,
          message: `Unable to stop addon: ${String(cause)}`,
        }),
    });

    if (process.platform !== 'win32' || !child.pid) return killChild;
    return Effect.async<void, AddonError>((resume) => {
      execFile(
        'taskkill.exe',
        ['/pid', String(child.pid), '/T', '/F'],
        (cause) =>
          resume(
            cause
              ? Effect.fail(
                  new AddonError({
                    addonName: this.config.name,
                    message: `Unable to terminate addon process tree: ${String(cause)}`,
                  })
                )
              : Effect.void
          )
      );
    }).pipe(Effect.catchAll(() => killChild));
  }

  private monitorProcess(child: ChildProcess): Effect.Effect<void, AddonError> {
    const name = this.config.name;
    return Effect.async<void, AddonError>((resume) => {
      let settled = false;
      const onStdout = (data: Buffer): void =>
        logger.sync.info(`[${name}] ${data}`);
      const onStderr = (data: Buffer): void =>
        logger.sync.error(`[${name}] ${data}`);
      const cleanup = (): void => {
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const finish = (effect: Effect.Effect<void, AddonError>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(effect);
      };
      const onError = (cause: Error): void =>
        finish(
          Effect.fail(
            new AddonError({
              addonName: name,
              message: `Addon process failed: ${String(cause)}`,
            })
          )
        );
      const onExit = (
        code: number | null,
        signal: NodeJS.Signals | null
      ): void => {
        const message = `[${name}] Exited with code ${code} and signal ${signal}`;
        finish(code === 0 ? logger.info(message) : logger.error(message));
      };

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.once('error', onError);
      child.once('exit', onExit);
      return Effect.sync(cleanup);
    });
  }

  public start(): Effect.Effect<void, AddonLifecycleError> {
    return Effect.gen(this, function* () {
      if (this.processScope) yield* this.stop();
      if (!this.config.scripts?.run) {
        const addonConfig = yield* AddonSetup.loadAddonConfig(this.config.path);
        this.config.scripts = addonConfig.scripts;
      }

      const { command, args } = yield* Addon.getScriptSpawnCommand(
        this.config.scripts.run,
        [
          `--addonPort=${this.config.port}`,
          `--addonSecret=${this.config.secret}`,
        ]
      );
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(this, function* () {
          const scope = yield* Scope.make();
          const child = yield* Effect.gen(this, function* () {
            const started = yield* Deferred.make<ChildProcess, AddonError>();
            const lifecycle = Effect.acquireUseRelease(
              this.spawnProcess(command, args),
              (child) =>
                Effect.sync(() => {
                  this.childProcess = child;
                }).pipe(
                  Effect.zipRight(Deferred.succeed(started, child)),
                  Effect.zipRight(this.monitorProcess(child))
                ),
              (child) => this.stopProcess(child).pipe(Effect.ignore)
            ).pipe(
              Effect.tapError((error) => Deferred.fail(started, error)),
              Effect.ensuring(
                Effect.sync(() => {
                  this.childProcess = null;
                })
              )
            );
            yield* Effect.forkIn(Effect.interruptible(lifecycle), scope);
            return yield* restore(Deferred.await(started));
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit)
            )
          );
          this.processScope = scope;
        })
      );
    });
  }

  public getChildProcess(): ChildProcess | null {
    return this.childProcess;
  }

  public stop(): Effect.Effect<void, AddonError> {
    return Effect.suspend(() => {
      const scope = this.processScope;
      if (!scope) return Effect.void;

      return Scope.close(scope, Exit.void).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.childProcess = null;
            this.processScope = null;
          })
        )
      );
    });
  }

  public restart(): Effect.Effect<void, AddonLifecycleError> {
    return this.stop().pipe(Effect.zipRight(this.start()));
  }
}
