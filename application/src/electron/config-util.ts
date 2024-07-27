import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const cachedValues: Record<string, Record<string, any>> = {};

export async function getStoredValue(optionName: string, key: string) { 
  const addonPath = './config/option/' + optionName + '.json';
  if (existsSync(addonPath) && !cachedValues[optionName]) {
    const selectedAddon = JSON.parse(await readFile(addonPath, 'utf-8'));
    cachedValues[optionName] = selectedAddon;
    return selectedAddon[key];
  }
  else if (cachedValues[optionName]) {
    return cachedValues[optionName][key];
  }
  return undefined;
}

export async function refreshCached(optionName: string) {
  const addonPath = './config/option/' + optionName + '.json';
  if (existsSync(addonPath)) {
    const selectedAddon = JSON.parse(await readFile(addonPath, 'utf-8'));
    cachedValues[optionName] = selectedAddon;
  }
}