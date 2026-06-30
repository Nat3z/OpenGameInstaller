import {
  Addon,
  AddonFileConfigurationSchema,
  type AddonFileConfiguration,
} from '@/addon';
import { spawn } from 'child_process';
import { join } from 'path';
import { access, writeFile } from 'fs/promises';
import { createWriteStream, readFileSync, rmSync } from 'fs';
import { Git } from '@/git';
import type z from 'zod';

export class AddonSetup {
  public git: Git;
  constructor(
    private readonly config: {
      path: string;
      name: string;
      scripts: AddonFileConfiguration['scripts'];
    }
  ) {
    this.git = new Git(config);
  }

  public static loadAddonConfig(
    path: string
  ): z.infer<typeof AddonFileConfigurationSchema> {
    const addonConfig = readFileSync(join(path, 'addon.json'), 'utf-8');
    return AddonFileConfigurationSchema.parse(addonConfig);
  }

  private runScript(script: string) {
    const startCommand = Addon.intoExecutor(script);

    console.log(`[${this.config.name}] Running script: ${startCommand}`);
    // get the installation log path
    const installationLogPath = join(this.config.path, 'installation.log');
    // create a write stream to the installation log
    const installationLogStream = createWriteStream(installationLogPath);
    // write at the beginning the command

    installationLogStream.write(`--------------------------------`);
    installationLogStream.write(
      `[${this.config.name}] Running script: ${startCommand}`
    );
    installationLogStream.write(`--------------------------------`);

    const { command, args } = Addon.getScriptSpawnCommand(script);
    const child = spawn(command, args, {
      cwd: this.config.path,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (data) => {
      console.log(`[${this.config.name}] ${data.toString()}`);
      installationLogStream.write(data.toString());
    });
    child.stderr?.on('data', (data) => {
      console.error(`[${this.config.name}] ${data.toString()}`);
      installationLogStream.write(data.toString());
    });
    child.on('error', (error) => {
      console.error(`[${this.config.name}] ${error}`);
      installationLogStream.write(error.message);
    });

    child.on('exit', (code, signal) => {
      console.log(
        `[${this.config.name}] Exited with code ${code} and signal ${signal}`
      );
      installationLogStream.write(
        `[${this.config.name}] Exited with code ${code} and signal ${signal}`
      );
      installationLogStream.end();
      if (code !== 0) {
        throw new Error(
          `[${this.config.name}] Exited with code ${code} and signal ${signal}`
        );
      }
    });

    return child;
  }

  private spawnScriptCapture(
    script: string,
    scriptName: string
  ): Promise<string> {
    const startCommand = Addon.intoExecutor(script);
    const name = this.config.name;

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      console.log(`[${name}@${scriptName}] Running script: ${startCommand}`);
      const { command, args } = Addon.getScriptSpawnCommand(script);
      const child = spawn(command, args, {
        cwd: this.config.path,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (data: Buffer) => {
        const t = data.toString();
        console.log(`[${name}@${scriptName}] ${t}`);
        stdout += t;
      });
      child.stderr?.on('data', (data: Buffer) => {
        const t = data.toString();
        console.error(`[${name}@${scriptName}] ${t}`);
        stderr += t;
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(
            new Error(`Addon ${name} exited with error: ${code}\n${stderr}`)
          );
          return;
        }
        resolve(stdout);
      });
      child.on('error', reject);
    });
  }

  /**
   * Runs optional pre/setup/post scripts and returns combined stdout (for `installation.log`).
   */
  public async collectSetupLog(): Promise<string> {
    const scripts = this.config.scripts;
    const addonName = this.config.name;
    let setupLogs = '';

    if (scripts.preSetup) {
      setupLogs += `\nRunning pre-setup script for ${addonName}...\n> ${scripts.preSetup}\n`;
      setupLogs += await this.spawnScriptCapture(scripts.preSetup, 'pre-setup');
    }
    if (scripts.setup) {
      setupLogs += `\nRunning setup script for ${addonName}...\n> ${scripts.setup}\n`;
      setupLogs += await this.spawnScriptCapture(scripts.setup, 'setup');
    }
    if (scripts.postSetup) {
      setupLogs += `\nRunning post-setup script for ${addonName}...\n> ${scripts.postSetup}\n`;
      setupLogs += await this.spawnScriptCapture(
        scripts.postSetup,
        'post-setup'
      );
    }

    return setupLogs;
  }

  public setup(): Promise<void> {
    if (!this.config.scripts?.setup) {
      throw new Error('Setup script not found');
    }
    const process = this.runScript(this.config.scripts.setup);

    return new Promise((resolve, reject) => {
      process.on('exit', (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `[${this.config.name}] Exited with code ${code} and signal ${signal}`
            )
          );
        }
        resolve();
      });
    });
  }

  public preSetup(): Promise<void> {
    if (!this.config.scripts?.preSetup) {
      throw new Error('Pre-setup script not found');
    }
    const process = this.runScript(this.config.scripts.preSetup);
    return new Promise((resolve, reject) => {
      process.on('exit', (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `[${this.config.name}] Exited with code ${code} and signal ${signal}`
            )
          );
        }
        resolve();
      });
    });
  }

  public postSetup(): Promise<void> {
    if (!this.config.scripts?.postSetup) {
      throw new Error('Post-setup script not found');
    }
    const process = this.runScript(this.config.scripts.postSetup);
    return new Promise((resolve, reject) => {
      process.on('exit', (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `[${this.config.name}] Exited with code ${code} and signal ${signal}`
            )
          );
        }
        resolve();
      });
    });
  }

  public async runSetup(): Promise<void> {
    // delete the installation log
    rmSync(join(this.config.path, 'installation.log'));
    await this.preSetup();
    await this.setup();
    await this.postSetup();
    // add installation log
    await this.createLogFile(await this.collectSetupLog());
  }

  private async createLogFile(content: string): Promise<void> {
    await writeFile(join(this.config.path, 'installation.log'), content);
  }

  public async isInstalled(): Promise<boolean> {
    try {
      await access(join(this.config.path, 'installation.log'));
      return true;
    } catch {
      return false;
    }
  }
}
