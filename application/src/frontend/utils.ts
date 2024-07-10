import type { OGIAddonConfiguration } from "ogi-addon";
import type { ConfigurationFile } from "ogi-addon/build/config/ConfigurationBuilder";
function getSecret() {
  const urlParams = new URLSearchParams(window.location.search);
  const addonSecret = urlParams.get('secret');
  return addonSecret;
}
const fs = window.electronAPI.fs;

interface ConsumableRequest extends RequestInit {
  consume?: 'json' | 'text';
}
export interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
  configTemplate: ConfigurationFile
}

export async function fsCheck(path: string) {
  try {
    return fs.exists(path);
  } catch (e) {
    return false;
  }
}

export function getConfigClientOption<T>(id: string): T | null {
  if (!fs.exists(`./config/options/${id}.json`)) return null;
  const config = fs.read(`./config/options/${id}.json`);
  return JSON.parse(config);
}
export function fetchAddonsWithConfigure() {
  return new Promise<ConfigTemplateAndInfo[]>((resolve, reject) => {
    safeFetch('http://localhost:7654/addons').then(async (addons: ConfigTemplateAndInfo[]) => {
      // now configure each addon
      for (const addon of addons) {
        // check if file exists
        if (!fs.exists(`./config/${addon.id}.json`)) {
          // if it doesn't exist, create it with default values
          let defaultConfig: Record<string, number | boolean | string> = {};
          for (const key in addon.configTemplate) {
            defaultConfig[key] = addon.configTemplate[key].defaultValue as number | boolean | string;
          }
          fs.write(`./config/${addon.id}.json`, JSON.stringify(defaultConfig, null, 2));
        }
        const storedConfig = JSON.parse(fs.read(`./config/${addon.id}.json`));
        if (storedConfig) {
          console.log("Posting stored config for addon", addon.id, storedConfig);
          safeFetch("http://localhost:7654/addons/" + addon.id + "/config", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(storedConfig),
            consume: 'text'
          });
        }
        else {
          // if there is no stored config, we should store and send the default config
          let defaultConfig: Record<string, number | boolean | string> = {};
          for (const key in addon.configTemplate) {
            defaultConfig[key] = addon.configTemplate[key].defaultValue as number | boolean | string;
          }
          // then store with fs
          fs.write(`./config/${addon.id}.json`, JSON.stringify(defaultConfig, null, 2));
          // then post
          safeFetch("http://localhost:7654/addons/" + addon.id + "/config", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(defaultConfig),
            consume: 'text'
          });
        }
      }
      resolve(addons);
    });
  });
}
export async function safeFetch(url: string, options: ConsumableRequest = { consume: 'json' }) {
  return new Promise<any>((resolve, reject) => {
    fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': getSecret()!!
      }
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(response.statusText);
      }
      const clonedCheck = response.clone();
      // if the task is deferred, we should poll the task until it's done.
      if (response.status === 202) {
        const taskID = (await clonedCheck.json()).taskID;
        const deferInterval = setInterval(async () => {
          const taskResponse = await fetch(`http://localhost:7654/defer/${taskID}`, {
            headers: {
              'Authorization': getSecret()!!
            }
          });
          if (taskResponse.status === 404) {
            reject('Task not found when deferring.');
            clearInterval(deferInterval);
          }
          if (taskResponse.status === 200) {
            const taskData = await taskResponse.json();
            clearInterval(deferInterval);
            resolve(taskData);
          }
        }, 850);
      }
      else {
        if (!options.consume || options.consume === 'json') return resolve(await response.json());
        else if (options.consume === 'text') return resolve(await response.text());
        else throw new Error('Invalid consume type');
      }
    });
  });
}