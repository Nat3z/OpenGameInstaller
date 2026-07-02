import * as fs from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { LibraryInfo, OGIAddonSDKEventListener } from '@ogi-sdk/connect';
import { restartAddonServer } from '@/electron/handlers/handler.addon.js';
import { __dirname } from '@/electron/manager/manager.paths.js';
import { addonServer } from '@/electron/server/addon-server.js';

export type DeleteInstalledAddonResult = {
  success: boolean;
  message?: string;
};

export type RunLaunchAppHooksResult = {
  success: boolean;
  error?: string;
};

export function isAddonEventAvailable(
  client: { eventsAvailable?: OGIAddonSDKEventListener[] } | undefined,
  event: OGIAddonSDKEventListener
): boolean {
  return client?.eventsAvailable?.includes(event) === true;
}

export async function deleteInstalledAddon(
  addonID: string
): Promise<DeleteInstalledAddonResult> {
  const client = addonServer.getClient(addonID);
  if (!client) {
    return { success: false, message: 'Client not found' };
  }
  if (!client.addonInfo) {
    return { success: false, message: 'Client has no addon info' };
  }
  if (!client.addonLink || client.addonLink.startsWith('local@')) {
    return {
      success: false,
      message:
        'Addon was not spawned by OpenGameInstaller or is a "local@..." addon.',
    };
  }

  const generalConfigPath = join(__dirname, 'config/option/general.json');
  const generalConfig = JSON.parse(
    readFileSync(generalConfigPath, 'utf-8')
  ) as { addons: string[] };

  generalConfig.addons = generalConfig.addons.filter(
    (addon) => addon !== client.addonLink
  );

  writeFileSync(generalConfigPath, JSON.stringify(generalConfig, null, 2));

  await restartAddonServer();
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const promises = await Promise.allSettled([
    fs.rm(client.filePath!!, {
      recursive: true,
      force: true,
    }),
    fs.rm(join(__dirname, 'config', addonID), {
      recursive: true,
      force: true,
    }),
  ]);

  if (promises[0].status === 'fulfilled') {
    console.log('Addon removed from addons folder');
  } else {
    console.error('Failed to remove addon from addons folder');
  }
  if (promises[1].status === 'fulfilled') {
    console.log('Addon removed from config folder');
  } else {
    console.error('Failed to remove addon from config folder');
  }

  if (promises[0].status === 'fulfilled') {
    return { success: true };
  }

  return { success: false, message: 'Failed to remove addon' };
}

export async function runLaunchAppHooks(
  libraryInfo: LibraryInfo,
  launchType: 'pre' | 'post'
): Promise<RunLaunchAppHooksResult> {
  const clientsWithEvent = Array.from(
    addonServer.getConnections().values()
  ).filter((client) => isAddonEventAvailable(client, 'launch-app'));

  if (clientsWithEvent.length === 0) {
    return { success: true };
  }

  try {
    await Promise.all(
      clientsWithEvent.map(async (client) => {
        if (!isAddonEventAvailable(client, 'launch-app')) {
          return;
        }

        await client.events.launchApp({
          libraryInfo,
          launchType,
        });
      })
    );
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
