import { safeFetch } from '../core/ipc';
export function getConfigClientOption(id) {
    if (!window.electronAPI.fs.exists(`./config/option/${id}.json`))
        return null;
    const config = window.electronAPI.fs.read(`./config/option/${id}.json`);
    return JSON.parse(config);
}
export function fetchAddonsWithConfigure() {
    return new Promise((resolve, _) => {
        safeFetch('getAllAddons', {}).then(async (addons) => {
            // now configure each addon
            for (const addon of addons) {
                // check if file exists
                if (!window.electronAPI.fs.exists(`./config/${addon.id}.json`)) {
                    // if it doesn't exist, create it with default values
                    let defaultConfig = {};
                    for (const key in addon.configTemplate) {
                        defaultConfig[key] = addon.configTemplate[key].defaultValue;
                    }
                    window.electronAPI.fs.write(`./config/${addon.id}.json`, JSON.stringify(defaultConfig, null, 2));
                }
                const storedConfig = JSON.parse(window.electronAPI.fs.read(`./config/${addon.id}.json`));
                if (storedConfig) {
                    console.log('Posting stored config for addon', addon.id, storedConfig);
                    safeFetch('updateConfig', {
                        addonID: addon.id,
                        config: storedConfig,
                    }, {
                        consume: 'text',
                    });
                }
                else {
                    // if there is no stored config, we should store and send the default config
                    let defaultConfig = {};
                    for (const key in addon.configTemplate) {
                        defaultConfig[key] = addon.configTemplate[key].defaultValue;
                    }
                    // then store with fs
                    window.electronAPI.fs.write(`./config/${addon.id}.json`, JSON.stringify(defaultConfig, null, 2));
                    // then post
                    safeFetch('updateConfig', {
                        addonID: addon.id,
                        config: defaultConfig,
                    }, {
                        consume: 'text',
                    });
                }
            }
            resolve(addons);
        });
    });
}
//# sourceMappingURL=client.js.map