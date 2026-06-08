import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { sendNotification } from '@/electron/main.js';
import {
  Addon as ExecutorAddon,
  AddonFileConfigurationSchema,
} from '@ogi-sdk/executor';
import type { AddonConnection } from '@ogi-sdk/addon-server';
import { addonServer, port } from '@/electron/server/addon-server.js';

export class Addon extends ExecutorAddon {
  /** Paths of addons currently started by the host (for shutdown / restart). */
  static readonly running = new Map<string, Addon>();

  private static stripAnsi(input: string): string {
    return input.replace(/\x1b\[[0-9;]*m/g, '');
  }

  static async load(addonPath: string): Promise<Addon | null> {
    const addonName =
      addonPath.replace(/\/$/, '').split(/[/\\]/).pop() ?? 'unknown-addon';

    let addonConfig: string;
    try {
      addonConfig = await readFile(join(addonPath, 'addon.json'), 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        sendNotification({
          type: 'error',
          message: `Addon configuration not found for ${addonName}`,
          id: Math.random().toString(36).substring(7),
        });
      } else {
        sendNotification({
          type: 'error',
          message: `Error reading addon configuration for ${addonName}: ${err.message}`,
          id: Math.random().toString(36).substring(7),
        });
      }
      return null;
    }

    let addonJSON: unknown;
    try {
      addonJSON = JSON.parse(addonConfig);
    } catch (err: any) {
      sendNotification({
        type: 'error',
        message: `Failed to parse addon configuration JSON for ${addonName}: ${err.message}`,
        id: Math.random().toString(36).substring(7),
      });
      return null;
    }

    try {
      const parsed = AddonFileConfigurationSchema.parse(addonJSON);
      return new Addon({
        port,
        secret: addonServer.getSecret(),
        path: addonPath,
        name: addonName,
        scripts: parsed.scripts,
      });
    } catch (err: any) {
      sendNotification({
        type: 'error',
        message: `Addon configuration validation failed for ${addonName}: ${err.message}`,
        id: Math.random().toString(36).substring(7),
      });
      return null;
    }
  }

  override stop(): void {
    super.stop();
    Addon.running.delete(this.config.path);
  }

  async install(): Promise<boolean> {
    sendNotification({
      type: 'info',
      message: 'Setting up ' + this.config.name,
      id: Math.random().toString(36).substring(7),
    });

    try {
      const setupLogs = await this.setup.collectSetupLog();
      await writeFile(
        join(this.config.path, 'installation.log'),
        Addon.stripAnsi(setupLogs)
      );
      return true;
    } catch (err) {
      console.error(
        `Error running setup scripts for ${this.config.name}:`,
        err
      );
      sendNotification({
        type: 'error',
        message: 'Error running setup scripts for ' + this.config.name,
        id: Math.random().toString(36).substring(7),
      });
      return false;
    }
  }

  async startRegistered(
    addonLink: string
  ): Promise<AddonConnection | undefined> {
    const addonName = this.config.name;
    const addonPath = this.config.path;

    try {
      this.start();

      const child = this.getChildProcess();
      if (!child) {
        return;
      }
      Addon.running.set(addonPath, this);

      let attempts = 0;
      const success = await new Promise<boolean>((resolve) => {
        const interval = setInterval(() => {
          if (attempts > 10) {
            clearInterval(interval);
            console.error(
              'Addon ' +
                addonName +
                ' not found in clients. Cannot attach path nor link.'
            );
            resolve(false);
            return;
          }

          if (addonServer.getClient(addonName)) {
            clearInterval(interval);
            resolve(true);
            return;
          }
          attempts++;
        }, 500);
      });

      if (!success) {
        return;
      }

      const client = addonServer.getClient(addonName);
      if (client) {
        client.filePath = addonPath;
        client.addonLink = addonLink;
        console.log(
          'Registered addon identifier path for ' +
            addonName +
            ' to ' +
            addonPath +
            ' with link ' +
            addonLink
        );
      }
      return client;
    } catch (e) {
      console.error(e);

      const errorMessage = e instanceof Error ? e.message : String(e);
      await writeFile(
        join(addonPath, 'run-crash.log'),
        Addon.stripAnsi(errorMessage)
      );

      sendNotification({
        type: 'error',
        message:
          'Error running run script for ' + addonPath.split(/[/\\]/).pop(),
        id: Math.random().toString(36).substring(7),
      });
      return;
    }
  }
}
