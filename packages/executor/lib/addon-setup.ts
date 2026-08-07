import { spawn } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AddonError, FileSystemError, ValidationError } from '@ogi/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { Effect, Schema } from 'effect';
import {
  Addon,
  type AddonFileConfiguration,
  AddonFileConfigurationSchema,
} from '@/addon';
import { Git } from '@/git';

const logger = createLogger(LOGGER_PREFIXES.executor);

type SetupError = AddonError | FileSystemError | ValidationError;

/** Effect-based setup script runner for an addon. */
export class AddonSetup {
  public readonly git: Git;

  constructor(
    private readonly config: {
      readonly path: string;
      readonly name: string;
      readonly scripts: AddonFileConfiguration['scripts'];
    }
  ) {
    this.git = new Git(config);
  }

  public static loadAddonConfig(
    path: string
  ): Effect.Effect<AddonFileConfiguration, FileSystemError | ValidationError> {
    const configPath = join(path, 'addon.json');
    return Effect.gen(function* () {
      const contents = yield* Effect.tryPromise({
        try: () => readFile(configPath, 'utf-8'),
        catch: (cause) =>
          new FileSystemError({
            path: configPath,
            message: `Unable to read addon configuration: ${String(cause)}`,
            cause,
          }),
      });
      const json = yield* Effect.try({
        try: () => JSON.parse(contents) as unknown,
        catch: (cause) =>
          new ValidationError({
            message: `Invalid addon.json: ${String(cause)}`,
          }),
      });
      return yield* Schema.decodeUnknown(AddonFileConfigurationSchema)(
        json
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ValidationError({
              message: `Invalid addon configuration: ${String(cause)}`,
            })
        )
      );
    });
  }

  /** Runs one setup script and captures its stdout for the installation log. */
  private runScriptCapture(
    script: string,
    scriptName: string
  ): Effect.Effect<string, AddonError | ValidationError> {
    return Effect.gen(this, function* () {
      const startCommand = yield* Addon.intoExecutor(script);
      if (startCommand.trim() === '') {
        return yield* Effect.fail(
          new ValidationError({ message: 'Addon command is empty' })
        );
      }

      const { command, args } =
        process.platform === 'win32'
          ? yield* Addon.getScriptSpawnCommand(script)
          : { command: '/bin/sh', args: ['-c', startCommand] };
      const child = yield* Effect.try({
        try: () =>
          spawn(command, args, {
            cwd: this.config.path,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        catch: (cause) =>
          new AddonError({
            addonName: this.config.name,
            message: `Unable to run ${scriptName}: ${String(cause)}`,
          }),
      });
      const name = this.config.name;
      yield* logger.info(
        `[${name}@${scriptName}] Running script: ${startCommand}`
      );

      return yield* Effect.async<string, AddonError>((resume) => {
        let stdout = '';
        let stderr = '';
        let settled = false;

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          stdout += text;
          logger.sync.info(`[${name}@${scriptName}] ${text}`);
        });
        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          stderr += text;
          logger.sync.error(`[${name}@${scriptName}] ${text}`);
        });
        child.on('error', (cause) => {
          if (settled) return;
          settled = true;
          resume(
            Effect.fail(
              new AddonError({
                addonName: name,
                message: `Unable to run ${scriptName}: ${String(cause)}`,
              })
            )
          );
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          if (code !== 0) {
            resume(
              Effect.fail(
                new AddonError({
                  addonName: name,
                  message: `${scriptName} exited with code ${code} and signal ${signal}\n${stderr}`,
                })
              )
            );
          } else {
            resume(Effect.succeed(stdout));
          }
        });

        return Effect.sync(() => {
          if (!settled) child.kill();
        });
      });
    });
  }

  /** Runs optional pre/setup/post scripts and returns their combined stdout. */
  public collectSetupLog(): Effect.Effect<string, SetupError> {
    return Effect.gen(this, function* () {
      const scripts = this.config.scripts;
      const addonName = this.config.name;
      let setupLogs = '';

      if (scripts.preSetup) {
        setupLogs += `\nRunning pre-setup script for ${addonName}...\n> ${scripts.preSetup}\n`;
        setupLogs += yield* this.runScriptCapture(
          scripts.preSetup,
          'pre-setup'
        );
      }
      if (scripts.setup) {
        setupLogs += `\nRunning setup script for ${addonName}...\n> ${scripts.setup}\n`;
        setupLogs += yield* this.runScriptCapture(scripts.setup, 'setup');
      }
      if (scripts.postSetup) {
        setupLogs += `\nRunning post-setup script for ${addonName}...\n> ${scripts.postSetup}\n`;
        setupLogs += yield* this.runScriptCapture(
          scripts.postSetup,
          'post-setup'
        );
      }
      return setupLogs;
    });
  }

  public setup(): Effect.Effect<void, SetupError> {
    if (!this.config.scripts.setup) {
      return Effect.fail(
        new AddonError({
          addonName: this.config.name,
          message: 'Setup script not found',
        })
      );
    }
    return this.runScriptCapture(this.config.scripts.setup, 'setup').pipe(
      Effect.asVoid
    );
  }

  public preSetup(): Effect.Effect<void, SetupError> {
    if (!this.config.scripts.preSetup) {
      return Effect.fail(
        new AddonError({
          addonName: this.config.name,
          message: 'Pre-setup script not found',
        })
      );
    }
    return this.runScriptCapture(
      this.config.scripts.preSetup,
      'pre-setup'
    ).pipe(Effect.asVoid);
  }

  public postSetup(): Effect.Effect<void, SetupError> {
    if (!this.config.scripts.postSetup) {
      return Effect.fail(
        new AddonError({
          addonName: this.config.name,
          message: 'Post-setup script not found',
        })
      );
    }
    return this.runScriptCapture(
      this.config.scripts.postSetup,
      'post-setup'
    ).pipe(Effect.asVoid);
  }

  public runSetup(): Effect.Effect<void, SetupError> {
    const logPath = join(this.config.path, 'installation.log');
    return Effect.gen(this, function* () {
      yield* Effect.tryPromise({
        try: () => rm(logPath, { force: true }),
        catch: (cause) =>
          new FileSystemError({
            path: logPath,
            message: `Unable to remove old installation log: ${String(cause)}`,
            cause,
          }),
      });
      const log = yield* this.collectSetupLog();
      yield* this.createLogFile(log);
    });
  }

  private createLogFile(content: string): Effect.Effect<void, FileSystemError> {
    const logPath = join(this.config.path, 'installation.log');
    return Effect.tryPromise({
      try: () => writeFile(logPath, content),
      catch: (cause) =>
        new FileSystemError({
          path: logPath,
          message: `Unable to write installation log: ${String(cause)}`,
          cause,
        }),
    });
  }

  public isInstalled(): Effect.Effect<boolean> {
    const logPath = join(this.config.path, 'installation.log');
    return Effect.tryPromise(() => access(logPath)).pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true })
    );
  }
}
