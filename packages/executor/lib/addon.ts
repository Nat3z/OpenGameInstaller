import { ChildProcess, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import parseArgsStringToArgv from 'string-argv';
import z from 'zod';
import { AddonSetup } from '@/addon-setup';

export type AddonConfig = {
  port: number;
  secret: string;
  path: string;
  name: string;
  scripts?: z.infer<typeof AddonFileConfigurationSchema>['scripts'];
};

export const AddonFileConfigurationSchema = z.object({
  author: z.string(),
  scripts: z.object({
    setup: z.string().optional(),
    run: z.string(),
    preSetup: z.string().optional(),
    postSetup: z.string().optional(),
  }),
});

export class Addon {
  public config: AddonConfig;
  private process: ChildProcess | null = null;
  private abort = new AbortController();
  public setup: AddonSetup;

  constructor(config: AddonConfig) {
    this.config = config;
    this.setup = new AddonSetup(this);
  }

  public static getBunPath(): string {
    if (process.platform === 'win32') {
      return join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe');
    } else {
      return join(process.env.HOME || '', '.bun', 'bin', 'bun');
    }
  }

  public loadAddonConfig(
    path: string
  ): z.infer<typeof AddonFileConfigurationSchema> {
    const addonConfig = readFileSync(join(path, 'addon.json'), 'utf-8');
    return AddonFileConfigurationSchema.parse(addonConfig);
  }

  public static intoExecutor(fullCommand: string): string {
    // turn any 'bun' from the line command into the full path to bun
    fullCommand = fullCommand.replace(
      /^(\.?[\\/]?bun(?:.exe)?)\b/,
      `"${this.getBunPath()}"`
    );
    return fullCommand;
  }

  public start(): void {
    if (!this.config.scripts?.run) {
      // load the addon config
      const addonConfig = this.loadAddonConfig(this.config.path);
      this.config.scripts = addonConfig.scripts;
    }

    // start the addon from the path with the given config
    const startCommand = Addon.intoExecutor(this.config.scripts.run);
    // split into the command and the arguments
    const [command, ...args] = parseArgsStringToArgv(startCommand);
    const child = spawn(
      command!,
      [
        ...args,
        '--addonSecret=' + this.config.secret,
        '--addonPort=' + this.config.port.toString(),
      ],
      {
        cwd: this.config.path,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: this.abort.signal,
      }
    );

    // register the stdout and stderr to the console

    child.stdout?.on('data', (data) => {
      console.log(`[${this.config.name}] ${data.toString()}`);
    });
    child.stderr?.on('data', (data) => {
      console.error(`[${this.config.name}] ${data.toString()}`);
    });

    child.on('error', (error) => {
      console.error(`[${this.config.name}] ${error}`);
    });

    child.on('exit', (code, signal) => {
      console.log(
        `[${this.config.name}] Exited with code ${code} and signal ${signal}`
      );
      if (code !== 0) {
        throw new Error(
          `[${this.config.name}] Exited with code ${code} and signal ${signal}`
        );
      }
    });

    this.process = child;
  }

  public stop(): void {
    this.abort.abort();
    this.process?.kill();
    this.process = null;
  }

  public restart(): void {
    this.stop();
    this.start();
  }
}
