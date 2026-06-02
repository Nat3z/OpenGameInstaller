import type {
  ConfigurationFile,
  ConfigurationOptionWire,
  OGIAddonConfiguration,
} from '@ogi-sdk/connect';
import {
  isBooleanOption,
  isNumberOption,
  isStringOption,
} from 'ogi-addon/config';
import { addonServer, queryConnectedAddons } from '@/frontend/lib/core/ipc';

export interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
  configTemplate: ConfigurationFile;
}

export function validateAddonId(id: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    console.error(`Invalid addon id "${id}": rejected for path safety`);
    return null;
  }
  return id;
}

function addonConfigPath(addonId: string): string {
  return `./config/${addonId}.json`;
}

function defaultConfigValue(
  option: ConfigurationOptionWire
): number | boolean | string | undefined {
  if (isBooleanOption(option)) {
    return typeof option.defaultValue === 'boolean'
      ? option.defaultValue
      : false;
  }
  if (isNumberOption(option)) {
    return typeof option.defaultValue === 'number'
      ? option.defaultValue
      : (option.min ?? 0);
  }
  if (isStringOption(option)) {
    if (typeof option.defaultValue === 'string') {
      return option.defaultValue;
    }
    if ((option.allowedValues?.length ?? 0) > 0) {
      return option.allowedValues![0];
    }
    return '';
  }
  return undefined;
}

function buildDefaultConfig(
  configTemplate: ConfigurationFile
): Record<string, number | boolean | string> {
  const config: Record<string, number | boolean | string> = {};
  for (const key in configTemplate) {
    const value = defaultConfigValue(configTemplate[key]);
    if (value !== undefined) {
      config[key] = value;
    }
  }
  return config;
}

export function getConfigClientOption<T>(id: string): T | null {
  const safeId = validateAddonId(id);
  if (!safeId) return null;
  if (!window.electronAPI.fs.exists('./config/option/' + safeId + '.json'))
    return null;
  const config = window.electronAPI.fs.read(
    './config/option/' + safeId + '.json'
  );
  return JSON.parse(config) as T;
}
export async function fetchAddonsWithConfigure() {
  const addons = await queryConnectedAddons<ConfigTemplateAndInfo>();

  await Promise.all(
    addons.map(async (addon) => {
      const safeId = validateAddonId(addon.id);
      if (!safeId) return;

      const configPath = addonConfigPath(safeId);
      let config: Record<string, number | boolean | string>;

      if (!window.electronAPI.fs.exists(configPath)) {
        config = buildDefaultConfig(addon.configTemplate);
        window.electronAPI.fs.write(
          configPath,
          JSON.stringify(config, null, 2)
        );
      } else {
        try {
          config = JSON.parse(window.electronAPI.fs.read(configPath));
        } catch (e) {
          console.error(
            `Failed to parse config for ${safeId}, regenerating defaults:`,
            e
          );
          config = buildDefaultConfig(addon.configTemplate);
          window.electronAPI.fs.write(
            configPath,
            JSON.stringify(config, null, 2)
          );
        }
      }

      console.log('Posting stored config for addon', safeId, config);
      await addonServer.addon(safeId).configUpdate(config as any);
    })
  );

  return addons;
}
