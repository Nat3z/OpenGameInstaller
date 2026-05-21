import type { OGIAddonConfiguration } from 'ogi-addon';
import type { ConfigurationFile } from 'ogi-addon/config';
import { addonServer, queryConnectedAddons } from '@/frontend/lib/core/ipc';

export interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
  configTemplate: ConfigurationFile;
}

export function getConfigClientOption<T>(id: string): T | null {
  if (!window.electronAPI.fs.exists(`./config/option/${id}.json`)) return null;
  const config = window.electronAPI.fs.read(`./config/option/${id}.json`);
  return JSON.parse(config);
}
export function fetchAddonsWithConfigure() {
  return new Promise<ConfigTemplateAndInfo[]>((resolve, _) => {
    queryConnectedAddons<ConfigTemplateAndInfo>().then(
      async (addons: ConfigTemplateAndInfo[]) => {
        // now configure each addon
        for (const addon of addons) {
          // check if file exists
          if (!window.electronAPI.fs.exists(`./config/${addon.id}.json`)) {
            // if it doesn't exist, create it with default values
            let defaultConfig: Record<string, number | boolean | string> = {};
            for (const key in addon.configTemplate) {
              defaultConfig[key] = addon.configTemplate[key].defaultValue as
                | number
                | boolean
                | string;
            }
            window.electronAPI.fs.write(
              `./config/${addon.id}.json`,
              JSON.stringify(defaultConfig, null, 2)
            );
          }
          const storedConfig = JSON.parse(
            window.electronAPI.fs.read(`./config/${addon.id}.json`)
          );
          if (storedConfig) {
            console.log(
              'Posting stored config for addon',
              addon.id,
              storedConfig
            );
            addonServer.addon(addon.id).configUpdate(storedConfig as any);
          } else {
            // if there is no stored config, we should store and send the default config
            let defaultConfig: Record<string, number | boolean | string> = {};
            for (const key in addon.configTemplate) {
              defaultConfig[key] = addon.configTemplate[key].defaultValue as
                | number
                | boolean
                | string;
            }
            // then store with fs
            window.electronAPI.fs.write(
              `./config/${addon.id}.json`,
              JSON.stringify(defaultConfig, null, 2)
            );
            // then post
            addonServer.addon(addon.id).configUpdate(defaultConfig as any);
          }
        }
        resolve(addons);
      }
    );
  });
}
