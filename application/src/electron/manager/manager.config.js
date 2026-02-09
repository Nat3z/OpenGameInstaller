import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { __dirname } from './manager.paths.js';
const cachedValues = {};
export async function getStoredValue(optionName, key) {
    const addonPath = __dirname + '/config/option/' + optionName + '.json';
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
export async function refreshCached(optionName) {
    const addonPath = __dirname + '/config/option/' + optionName + '.json';
    if (existsSync(addonPath)) {
        const selectedAddon = JSON.parse(await readFile(addonPath, 'utf-8'));
        cachedValues[optionName] = selectedAddon;
    }
}
//# sourceMappingURL=manager.config.js.map