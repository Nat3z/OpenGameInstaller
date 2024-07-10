import type { OGIAddonConfiguration } from "ogi-addon";
import type { ConfigurationFile } from "ogi-addon/build/config/ConfigurationBuilder";
import { require } from '@electron/remote'
const fs = require('fs/promises')
function getSecret() {
  const urlParams = new URLSearchParams(window.location.search);
  const addonSecret = urlParams.get('secret');
  return addonSecret;
}

interface ConsumableRequest extends RequestInit {
  consume?: 'json' | 'text';
}
export interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
  configTemplate: ConfigurationFile
}

export async function fsCheckAndMake(path: string, fileType: 'directory' | 'file', data?: string | Record<string, any>) {
  try {
    await fs.access(path);
  } catch (e) {
    if (fileType === 'directory') {
      await fs.mkdir(path);
    }
    else if (fileType === 'file') {
      await fs.writeFile(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    }
  }
}
export async function fsCheck(path: string) {
  try {
    await fs.access(path);
    return true;
  } catch (e) {
    return false;
  }
}

export function fetchAddonsWithConfigure() {
  return new Promise<ConfigTemplateAndInfo[]>((resolve, reject) => {
    safeFetch('http://localhost:7654/addons').then(async (addons: ConfigTemplateAndInfo[]) => {
      // now configure each addon
      for (const addon of addons) {
        // check if file exists
        const configExists = await fsCheck(`./config/${addon.id}.json`);
        if (!configExists) {
          // if it doesn't exist, create it with default values
          let defaultConfig: Record<string, number | boolean | string> = {};
          for (const key in addon.configTemplate) {
            defaultConfig[key] = addon.configTemplate[key].defaultValue as number | boolean | string;
          }
          await fs.writeFile(`./config/${addon.id}.json`, JSON.stringify(defaultConfig, null, 2));
          continue
        }
        const storedConfig = JSON.parse(await fs.readFile(`./config/${addon.id}.json`, 'utf-8'));
        if (storedConfig) {
          console.log("Posting stored config for addon", addon.id);
          safeFetch("http://localhost:7654/addons/" + addon.id + "/config", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: storedConfig,
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
          await fs.writeFile(`./config/${addon.id}.json`, JSON.stringify(defaultConfig, null, 2));
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