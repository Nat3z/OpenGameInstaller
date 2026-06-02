import type { AddonConnection } from '@ogi-sdk/addon-server';
import { addonServer } from '@/electron/server/addon-server.js';
import { Addon } from '@/electron/manager/manager.addon.js';

function addonFolderName(addonPath: string): string {
  return addonPath.replace(/\/$/, '').split(/[/\\]/).pop() ?? addonPath;
}

function configuredRunningConnections(): AddonConnection[] {
  const configured: AddonConnection[] = [];
  for (const addonPath of Addon.running.keys()) {
    const client = addonServer.getClient(addonFolderName(addonPath));
    if (client?.addonInfo && client.configTemplate !== undefined) {
      configured.push(client);
    }
  }
  return configured;
}

export async function waitForAddonsConfigured(
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<AddonConnection[]> {
  const { timeoutMs = 30_000, pollIntervalMs = 100 } = options;
  const expectedCount = Addon.running.size;

  if (expectedCount === 0) {
    return [];
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = configuredRunningConnections();
    if (ready.length >= expectedCount) {
      return ready;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const ready = configuredRunningConnections();
  console.warn(
    `[addon-readiness] Timed out waiting for addons to send configure (${ready.length}/${expectedCount} ready)`
  );
  return ready;
}
