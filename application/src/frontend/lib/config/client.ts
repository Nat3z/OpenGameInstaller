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

const SAFE_ADDON_ID = /^[A-Za-z0-9_-]+$/;

export function validateAddonId(id: string): string | null {
  if (!SAFE_ADDON_ID.test(id)) {
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
  if (option.defaultValue !== undefined) {
    return option.defaultValue;
  }
  if (isBooleanOption(option)) {
    return false;
  }
  if (isNumberOption(option)) {
    return option.min ?? 0;
  }
  if (isStringOption(option)) {
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
  const path = addonConfigPath(safeId);
  if (!window.electronAPI.fs.exists(path)) return null;
  const config = window.electronAPI.fs.read(path);
  return JSON.parse(config);
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
