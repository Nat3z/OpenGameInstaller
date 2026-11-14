import type {
  ConfigurationFile,
  ConfigurationOptionWire,
} from '@ogi-sdk/connect';
import {
  isBooleanOption,
  isNumberOption,
  isStringOption,
} from 'ogi-addon/config';
import type { AddonConfigValues } from '@/lib/state.js';

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

export function buildDefaultConfig(
  configTemplate: ConfigurationFile
): AddonConfigValues {
  const config: AddonConfigValues = {};
  for (const key in configTemplate) {
    const value = defaultConfigValue(configTemplate[key]);
    if (value !== undefined) {
      config[key] = value;
    }
  }
  return config;
}
