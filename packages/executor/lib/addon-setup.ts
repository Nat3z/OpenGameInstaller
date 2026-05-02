import { Addon } from '@/addon';
import { spawn } from 'child_process';
import { join } from 'path';
import { access } from 'fs/promises';
import parseArgsStringToArgv from 'string-argv';
import { createWriteStream, rmSync, unlink } from 'fs';
import { Git } from '@/git';

export class AddonSetup {
  public git: Git;
  constructor(private readonly addon: Addon) {
    this.git = new Git(this.addon);
  }

  private runScript(script: string) {
    const startCommand = Addon.intoExecutor(script);
    const [command, ...args] = parseArgsStringToArgv(startCommand);

    console.log(`[${this.addon.config.name}] Running script: ${startCommand}`);
    // get the installation log path
    const installationLogPath = join(
      this.addon.config.path,
      'installation.log'
    );
    // create a write stream to the installation log
    const installationLogStream = createWriteStream(installationLogPath);
    // write at the beginning the command

    installationLogStream.write(`--------------------------------`);
    installationLogStream.write(
      `[${this.addon.config.name}] Running script: ${startCommand}`
    );
    installationLogStream.write(`--------------------------------`);

    const child = spawn(command!, args, {
      cwd: this.addon.config.path,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (data) => {
      console.log(`[${this.addon.config.name}] ${data.toString()}`);
      installationLogStream.write(data.toString());
    });
    child.stderr?.on('data', (data) => {
      console.error(`[${this.addon.config.name}] ${data.toString()}`);
      installationLogStream.write(data.toString());
    });
    child.on('error', (error) => {
      console.error(`[${this.addon.config.name}] ${error}`);
      installationLogStream.write(error.message);
    });

    child.on('exit', (code, signal) => {
      console.log(
        `[${this.addon.config.name}] Exited with code ${code} and signal ${signal}`
      );
      installationLogStream.write(
        `[${this.addon.config.name}] Exited with code ${code} and signal ${signal}`
      );
      installationLogStream.end();
      if (code !== 0) {
        throw new Error(
          `[${this.addon.config.name}] Exited with code ${code} and signal ${signal}`
        );
      }
    });

    return child;
  }

  public setup(): Promise<void> {
    if (!this.addon.config.scripts?.setup) {
      throw new Error('Setup script not found');
    }
    const process = this.runScript(this.addon.config.scripts.setup);

    return new Promise((resolve, reject) => {
      process.on('exit', (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `[${this.addon.config.name}] Exited with code ${code} and signal ${signal}`
            )
          );
        }
        resolve();
      });
    });
  }

  public preSetup(): Promise<void> {
    if (!this.addon.config.scripts?.preSetup) {
      throw new Error('Pre-setup script not found');
    }
    const process = this.runScript(this.addon.config.scripts.preSetup);
    return new Promise((resolve, reject) => {
      process.on('exit', (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `[${this.addon.config.name}] Exited with code ${code} and signal ${signal}`
            )
          );
        }
        resolve();
      });
    });
  }

  public postSetup(): Promise<void> {
    if (!this.addon.config.scripts?.postSetup) {
      throw new Error('Post-setup script not found');
    }
    const process = this.runScript(this.addon.config.scripts.postSetup);
    return new Promise((resolve, reject) => {
      process.on('exit', (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `[${this.addon.config.name}] Exited with code ${code} and signal ${signal}`
            )
          );
        }
        resolve();
      });
    });
  }

  public async runSetup(): Promise<void> {
    // delete the installation log
    rmSync(join(this.addon.config.path, 'installation.log'));
    await this.preSetup();
    await this.setup();
    await this.postSetup();
  }

  public async isInstalled(): Promise<boolean> {
    try {
      await access(join(this.addon.config.path, 'installation.log'));
      return true;
    } catch {
      return false;
    }
  }
}
