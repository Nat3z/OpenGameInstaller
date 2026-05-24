import type { ConfigurationFile, OGIAddonConfiguration } from '@ogi-sdk/connect';
import { addonServer, queryConnectedAddons } from '@/frontend/lib/core/ipc';

export interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
  configTemplate: ConfigurationFile;
}

export function getConfigClientOption<T>(id: string): T | null {
  if (!window.electronAPI.fs.exists(`./config/option/${id}.json`)) return null;
  const config = window.electronAPI.fs.read(`./config/option/${id}.json`);
  return JSON.parse(config);
}
export async function fetchAddonsWithConfigure() {
  const addons = await queryConnectedAddons<ConfigTemplateAndInfo>();

  await Promise.all(
    addons.map(async (addon) => {
      let config: Record<string, number | boolean | string>;

      if (!window.electronAPI.fs.exists(`./config/${addon.id}.json`)) {
        config = {};
        for (const key in addon.configTemplate) {
          config[key] = addon.configTemplate[key].defaultValue as
            | number
            | boolean
            | string;
        }
        window.electronAPI.fs.write(
          `./config/${addon.id}.json`,
          JSON.stringify(config, null, 2)
        );
      } else {
        try {
          config = JSON.parse(
            window.electronAPI.fs.read(`./config/${addon.id}.json`)
          );
        } catch (e) {
          console.error(
            `Failed to parse config for ${addon.id}, regenerating defaults:`,
            e
          );
          config = {};
          for (const key in addon.configTemplate) {
            config[key] = addon.configTemplate[key].defaultValue as
              | number
              | boolean
              | string;
          }
          window.electronAPI.fs.write(
            `./config/${addon.id}.json`,
            JSON.stringify(config, null, 2)
          );
        }
      }

      console.log('Posting stored config for addon', addon.id, config);
      await addonServer.addon(addon.id).configUpdate(config as any);
    })
  );

  return addons;
}
