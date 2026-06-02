import { getEffectiveOnlineState } from '@/electron/lib/online.js';
import {
  checkIfInstallerUpdateAvailable,
  type UpdaterCallbacks,
} from '@/electron/updater.js';
import { downloadLatestUmu } from '@/electron/startup.js';

export type SystemUpdateResult = {
  id: string;
  success: boolean;
  updated?: boolean;
  error?: string;
};

export interface SystemUpdater {
  id: string;
  label: string;
  shouldRun(): boolean | Promise<boolean>;
  update(callbacks: UpdaterCallbacks): Promise<SystemUpdateResult>;
}

export class SystemUpdateManager {
  private updaters: SystemUpdater[] = [];

  constructor(updaters: SystemUpdater[] = []) {
    this.updaters = [...updaters];
  }

  register(updater: SystemUpdater): void {
    this.updaters.push(updater);
  }

  async updateOnlineSystem(
    callbacks: UpdaterCallbacks
  ): Promise<SystemUpdateResult[]> {
    const onlineState = getEffectiveOnlineState();
    if (!onlineState.effectiveOnline) {
      console.log(
        `[system-updater] Offline mode enabled (${onlineState.reason}), skipping updates`
      );
      return [];
    }

    const results: SystemUpdateResult[] = [];
    for (const updater of this.updaters) {
      const shouldRun = await updater.shouldRun();
      if (!shouldRun) {
        console.log(`[system-updater] Skipping ${updater.id}`);
        continue;
      }

      callbacks.onStatus(`Checking ${updater.label} updates...`);
      try {
        results.push(await updater.update(callbacks));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[system-updater] ${updater.id} failed:`, error);
        results.push({ id: updater.id, success: false, error: message });
      }
    }

    return results;
  }
}

export class SetupAppImageUpdater implements SystemUpdater {
  id = 'setup-appimage';
  label = 'installer';

  shouldRun(): boolean {
    return true;
  }

  async update(callbacks: UpdaterCallbacks): Promise<SystemUpdateResult> {
    const result = await checkIfInstallerUpdateAvailable(callbacks);
    return {
      id: this.id,
      success: result.success,
      updated: result.updated,
      error: result.error,
    };
  }
}

export class UmuLauncherUpdater implements SystemUpdater {
  id = 'umu-launcher';
  label = 'UMU launcher';

  shouldRun(): boolean {
    return process.platform === 'linux';
  }

  async update(): Promise<SystemUpdateResult> {
    const result = await downloadLatestUmu();
    return {
      id: this.id,
      success: result.success,
      updated: result.updated,
      error: result.error,
    };
  }
}

export function createDefaultSystemUpdateManager(): SystemUpdateManager {
  return new SystemUpdateManager([
    new SetupAppImageUpdater(),
    new UmuLauncherUpdater(),
  ]);
}
