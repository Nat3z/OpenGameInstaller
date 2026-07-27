import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { AddonError, FileSystemError, ValidationError } from '@ogi/errors';
import { Effect, Schema } from 'effect';
import parseArgsStringToArgv from 'string-argv';
import { AddonSetup } from '@/addon-setup';
import { Git } from './git';

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
  scripts: AddonFileConfiguration['scripts'];
};

export type ScriptSpawnCommand = {
  readonly command: string;
  readonly args: string[];
};

/** Effect-based addon process lifecycle. */
export class Addon {
  public readonly setup: AddonSetup;
  private childProcess: ChildProcess | null = null;
  private abortController = new AbortController();

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
      try: () => execFileSync('which', ['bun'], { encoding: 'utf-8' }).trim(),
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

  public static intoExecutor(
    fullCommand: string
  ): Effect.Effect<string, AddonError> {
    return Effect.gen(function* () {
      const bunPath = yield* Addon.getBunPath();
      return fullCommand.replace(/^(\.?[\\/]?bun(?:.exe)?)\b/, `"${bunPath}"`);
    });
  }

  private static intoPowerShellScript(
    fullCommand: string
  ): Effect.Effect<string, AddonError> {
    return Addon.intoExecutor(fullCommand).pipe(
      Effect.map((command) => command.replace(/^"([^"]+)"/, '& "$1"'))
    );
  }

  public static getPowerShellExecutable(): string {
    return 'powershell.exe';
  }

  private static quotePowerShellArgument(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  public static getScriptSpawnCommand(
    script: string,
    extraArgs: string[] = []
  ): Effect.Effect<ScriptSpawnCommand, AddonError | ValidationError> {
    return Effect.gen(function* () {
      if (process.platform === 'win32') {
        const scriptCommand = yield* Addon.intoPowerShellScript(script);
        const command = [
          scriptCommand,
          ...extraArgs.map(Addon.quotePowerShellArgument),
        ].join(' ');
        return {
          command: Addon.getPowerShellExecutable(),
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            command,
          ],
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

  public start(): Effect.Effect<
    void,
    AddonError | FileSystemError | ValidationError
  > {
    return Effect.gen(this, function* () {
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
      const child = yield* Effect.try({
        try: () =>
          spawn(command, args, {
            cwd: this.config.path,
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: this.abortController.signal,
          }),
        catch: (cause) =>
          new AddonError({
            addonName: this.config.name,
            message: `Unable to start addon: ${String(cause)}`,
          }),
      });

      child.stdout?.on('data', (data) => {
        Effect.runFork(
          Effect.sync(() => console.log(`[${this.config.name}] ${data}`))
        );
      });
      child.stderr?.on('data', (data) => {
        Effect.runFork(
          Effect.sync(() => console.error(`[${this.config.name}] ${data}`))
        );
      });
      child.on('error', (cause) => {
        Effect.runFork(
          Effect.sync(() =>
            console.error(`[${this.config.name}] ${String(cause)}`)
          )
        );
      });
      child.on('exit', (code, signal) => {
        Effect.runFork(
          Effect.sync(() => {
            const message = `[${this.config.name}] Exited with code ${code} and signal ${signal}`;
            if (code === 0) console.log(message);
            else console.error(message);
          })
        );
      });
      this.childProcess = child;
    });
  }

  public getChildProcess(): ChildProcess | null {
    return this.childProcess;
  }

  public stop(): Effect.Effect<void, AddonError> {
    const child = this.childProcess;
    if (!child) return Effect.void;

    return Effect.gen(this, function* () {
      yield* Effect.sync(() => this.abortController.abort());

      const killChild = Effect.try({
        try: () => void child.kill(),
        catch: (cause) =>
          new AddonError({
            addonName: this.config.name,
            message: `Unable to stop addon: ${String(cause)}`,
          }),
      });

      if (process.platform === 'win32' && child.pid) {
        yield* Effect.try({
          try: () =>
            void execFileSync('taskkill.exe', [
              '/pid',
              String(child.pid),
              '/T',
              '/F',
            ]),
          catch: (cause) =>
            new AddonError({
              addonName: this.config.name,
              message: `Unable to terminate addon process tree: ${String(cause)}`,
            }),
        }).pipe(Effect.catchAll(() => killChild));
      } else {
        yield* killChild;
      }

      this.childProcess = null;
      this.abortController = new AbortController();
    });
  }

  public restart(): Effect.Effect<
    void,
    AddonError | FileSystemError | ValidationError
  > {
    return Effect.gen(this, function* () {
      yield* this.stop();
      yield* this.start();
    });
  }
}
