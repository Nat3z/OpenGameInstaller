import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import type { AddonConnection } from '@ogi-sdk/addon-server';
import { Effect } from 'effect';
import { Addon } from '@/electron/manager/manager.addon.js';
import { addonServer } from '@/electron/server/addon-server.js';

const logger = createLogger(LOGGER_PREFIXES.electron);

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

export function waitForAddonsConfigured(
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Effect.Effect<AddonConnection[]> {
  return Effect.gen(function* () {
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
      yield* Effect.sleep(`${pollIntervalMs} millis`);
    }

    const ready = configuredRunningConnections();
    logger.sync.warn(
      `[addon-readiness] Timed out waiting for addons to send configure (${ready.length}/${expectedCount} ready)`
    );
    return ready;
  });
}
