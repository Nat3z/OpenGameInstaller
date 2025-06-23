import type { OGIAddonConfiguration, SearchResult } from 'ogi-addon';
import type { ConfigurationFile } from 'ogi-addon/config';
import {
  createNotification,
  currentDownloads,
  notifications,
  failedSetups,
  deferredTasks,
  type FailedSetup,
  type DeferredTask,
} from './store';
import type { ResponseDeferredTask } from '../electron/server/api/defer';
function getSecret() {
  const urlParams = new URLSearchParams(window.location.search);
  const addonSecret = urlParams.get('secret');
  return addonSecret;
}

interface ConsumableRequest {
  consume?: 'json' | 'text';
  onProgress?: (progress: number) => void;
  onLogs?: (logs: string[]) => void;
  onFailed?: (error: string) => void;
}
export interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
  configTemplate: ConfigurationFile;
}

export function getDownloadPath(): string {
  if (!window.electronAPI.fs.exists('./config/option/general.json')) {
    if (!window.electronAPI.fs.exists('./downloads'))
      window.electronAPI.fs.mkdir('./downloads');
    createNotification({
      message: 'Download path not set, using default path (./downloads)',
      id: 'download-path',
      type: 'info',
    });
    return './downloads';
  }
  if (!window.electronAPI.fs.exists('./downloads'))
    window.electronAPI.fs.mkdir('./downloads');
  const file = window.electronAPI.fs.read('./config/option/general.json');
  const data = JSON.parse(file);
  return data.fileDownloadLocation;
}

export async function fsCheck(path: string) {
  try {
    return window.electronAPI.fs.exists(path);
  } catch (e) {
    return false;
  }
}

export function getConfigClientOption<T>(id: string): T | null {
  if (!window.electronAPI.fs.exists(`./config/option/${id}.json`)) return null;
  const config = window.electronAPI.fs.read(`./config/option/${id}.json`);
  return JSON.parse(config);
}
export function fetchAddonsWithConfigure() {
  return new Promise<ConfigTemplateAndInfo[]>((resolve, _) => {
    safeFetch('getAllAddons', {}).then(
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
            safeFetch(
              'updateConfig',
              {
                addonID: addon.id,
                config: storedConfig,
              },
              {
                consume: 'text',
              }
            );
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
            safeFetch(
              'updateConfig',
              {
                addonID: addon.id,
                config: defaultConfig,
              },
              {
                consume: 'text',
              }
            );
          }
        }
        resolve(addons);
      }
    );
  });
}
export async function safeFetch(
  method: string,
  params: any,
  options: ConsumableRequest = { consume: 'json' }
) {
  console.log(method, params);
  return new Promise<any>((resolve, reject) => {
    // remove the functions on the options object
    const fetchOptions = { ...options };
    delete fetchOptions.consume;
    delete fetchOptions.onProgress;
    delete fetchOptions.onLogs;
    delete fetchOptions.onFailed;
    window.electronAPI.app.request(method, params).then((response) => {
      if (response.error) {
        reject(response.error);
        return;
      }
      if (response.taskID) {
        const taskID = response.taskID;
        // if the task is deferred, we should poll the task until it's done.
        const deferInterval = setInterval(async () => {
          const taskResponse = await window.electronAPI.app.request('getTask', {
            taskID,
          });
          if (taskResponse.status === 404) {
            reject('Task not found when deferring.');
            clearInterval(deferInterval);
          } else if (taskResponse.status === 410) {
            reject('Addon is no longer connected');
            clearInterval(deferInterval);
          } else if (taskResponse.status === 500) {
            if (options.onFailed)
              options.onFailed(taskResponse.error ?? 'Task failed');
            clearInterval(deferInterval);
            reject('Task failed');
          }
          if (
            taskResponse.status === 200 &&
            taskResponse.data &&
            taskResponse.data.progress === undefined
          ) {
            // Task is completed
            clearInterval(deferInterval);
            if (!options || !options.consume || options.consume === 'json')
              return resolve(taskResponse.data);
            else if (options.consume === 'text')
              return resolve(taskResponse.data);
            else throw new Error('Invalid consume type');
          }
          if (
            taskResponse.status === 200 &&
            taskResponse.data &&
            taskResponse.data.progress !== undefined
          ) {
            // Task is still running
            const taskData: {
              progress: number;
              logs: string[];
              failed: string | undefined;
            } = taskResponse.data;
            if (options.onProgress) options.onProgress(taskData.progress);
            if (options.onLogs) options.onLogs(taskData.logs);
            if (options.onFailed && taskData.failed)
              options.onFailed(taskData.failed);
          }
        }, 100);
      } else {
        if (!options || !options.consume || options.consume === 'json')
          return resolve(response.data);
        else if (options.consume === 'text') return resolve(response.data);
        else throw new Error('Invalid consume type');
      }
    });
  });
}

export type SearchResultWithAddon = SearchResult & {
  addonSource: string;
  coverURL: string;
};
export async function startDownload(
  result: SearchResultWithAddon,
  appID: number,
  event: MouseEvent
) {
  if (event === null) return;
  if (event.target === null) return;
  const htmlButton = event.target as HTMLButtonElement;
  htmlButton.textContent = 'Downloading...';
  htmlButton.disabled = true;
  let downloadType = result.downloadType;
  if (downloadType === 'torrent' || downloadType === 'magnet') {
    const generalOptions = getConfigClientOption('general') as any;
    const torrentClient: 'webtorrent' | 'qbittorrent' | 'real-debrid' =
      (generalOptions ? generalOptions.torrentClient : null) ?? 'webtorrent';
    if (torrentClient === 'real-debrid') {
      downloadType = 'real-debrid-' + downloadType;
    }
  }

  switch (downloadType) {
    case 'request': {
      // now startTheDownload but this way
      const randomID = Math.random().toString(36).substring(7);
      currentDownloads.update((downloads) => {
        return [
          ...downloads,
          {
            id: randomID,
            status: 'requesting',
            downloadPath: getDownloadPath() + '/' + result.name,
            downloadSpeed: 0,
            progress: 0,
            usedRealDebrid: false,
            appID,
            downloadSize: 0,
            ...result,
          },
        ];
      });
      console.log('Requesting download', result);
      const response: SearchResult = await safeFetch(
        'requestDownload',
        {
          addonID: result.addonSource,
          appID: appID,
          info: result,
        },
        {
          consume: 'json',
          onFailed: (error: string) => {
            createNotification({
              id: Math.random().toString(36).substring(7),
              type: 'error',
              message: error,
            });
            currentDownloads.update((downloads) => {
              return downloads.map((d) => {
                if (d.id === randomID) {
                  d.status = 'errored';
                  d.error = error;
                }
                return d;
              });
            });
          },
        }
      );
      currentDownloads.update((downloads) => {
        return downloads.filter((d) => d.id !== randomID);
      });
      console.log(response);
      startDownload(
        {
          ...response,
          coverURL: result.coverURL,
          addonSource: result.addonSource,
        },
        appID,
        event
      );
      break;
    }
    case 'real-debrid-magnet': {
      if (!result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a magnet link.',
        });
        return;
      }
      const worked = await window.electronAPI.realdebrid.updateKey();
      if (!worked) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Please set your Real-Debrid API key in the settings.',
        });
        return;
      }
      // get the first host
      const hosts = await window.electronAPI.realdebrid.getHosts();
      const localID = Math.floor(Math.random() * 1000000);
      currentDownloads.update((downloads) => {
        return [
          ...downloads,
          {
            id: '' + localID,
            status: 'rd-downloading',
            downloadPath: getDownloadPath() + '/' + result.name,
            downloadSpeed: 0,
            usedRealDebrid: true,
            progress: 0,
            appID,
            downloadSize: 0,
            ...result,
          },
        ];
      });
      // add magnet link
      const magnetLink = await window.electronAPI.realdebrid.addMagnet(
        result.downloadURL,
        hosts[0]
      );
      const isReady = await window.electronAPI.realdebrid.isTorrentReady(
        magnetLink.id
      );
      if (!isReady) {
        window.electronAPI.realdebrid.selectTorrent(magnetLink.id);
        await new Promise<void>((resolve) => {
          const interval = setInterval(async () => {
            const isReady = await window.electronAPI.realdebrid.isTorrentReady(
              magnetLink.id
            );
            if (isReady) {
              clearInterval(interval);
              resolve();
            }
          }, 3000);
        });
      }

      const torrentInfo = await window.electronAPI.realdebrid.getTorrentInfo(
        magnetLink.id
      );
      const download = await window.electronAPI.realdebrid.unrestrictLink(
        torrentInfo.links[0]
      );

      if (download === null) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Failed to unrestrict the link.',
        });
        return;
      }
      const downloadID = await window.electronAPI.ddl.download([
        {
          link: download.download,
          path: getDownloadPath() + '/' + result.name + '/' + download.filename,
        },
      ]);
      if (downloadID === null) {
        if (htmlButton) {
          htmlButton.textContent = 'Download';
          htmlButton.disabled = false;
        }
        currentDownloads.update((downloads) => {
          const matchingDownload = downloads.find(
            (d) => d.id === localID + ''
          )!!;
          matchingDownload.status = 'error';
          matchingDownload.usedRealDebrid = true;
          downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
          return downloads;
        });

        return;
      }
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === localID + '')!!;
        matchingDownload.status = 'downloading';
        matchingDownload.id = downloadID;
        matchingDownload.usedRealDebrid = true;

        matchingDownload.downloadPath =
          getDownloadPath() + '/' + result.name + '/';
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });
      break;
    }
    case 'real-debrid-torrent': {
      if (!result.name || !result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a name for the torrent.',
        });
        return;
      }

      const worked = await window.electronAPI.realdebrid.updateKey();
      if (!worked) {
        notifications.update((notifications) => [
          ...notifications,
          {
            id: Math.random().toString(36).substring(7),
            type: 'error',
            message: 'Please set your Real-Debrid API key in the settings.',
          },
        ]);
        return;
      }
      // add torrent link
      const localID = Math.floor(Math.random() * 1000000);
      currentDownloads.update((downloads) => {
        return [
          ...downloads,
          {
            id: '' + localID,
            status: 'rd-downloading',
            downloadPath: getDownloadPath() + '/' + result.name,
            downloadSpeed: 0,
            usedRealDebrid: true,
            progress: 0,
            appID,
            downloadSize: 0,
            ...result,
          },
        ];
      });
      const torrent = await window.electronAPI.realdebrid.addTorrent(
        result.downloadURL
      );
      const isReady = await window.electronAPI.realdebrid.isTorrentReady(
        torrent.id
      );
      if (!isReady) {
        window.electronAPI.realdebrid.selectTorrent(torrent.id);
        await new Promise<void>((resolve) => {
          const interval = setInterval(async () => {
            const isReady = await window.electronAPI.realdebrid.isTorrentReady(
              torrent.id
            );
            if (isReady) {
              clearInterval(interval);
              resolve();
            }
          }, 3000);
        });
      }

      const torrentInfo = await window.electronAPI.realdebrid.getTorrentInfo(
        torrent.id
      );
      // currently only supporting the first link
      const download = await window.electronAPI.realdebrid.unrestrictLink(
        torrentInfo.links[0]
      );
      if (download === null) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Failed to unrestrict the link.',
        });
        return;
      }

      const downloadID = await window.electronAPI.ddl.download([
        {
          link: download.download,
          path: getDownloadPath() + '/' + result.name + '/' + download.filename,
        },
      ]);
      if (downloadID === null) {
        if (htmlButton) {
          htmlButton.textContent = 'Download';
          htmlButton.disabled = false;
        }
        currentDownloads.update((downloads) => {
          const matchingDownload = downloads.find(
            (d) => d.id === localID + ''
          )!!;
          matchingDownload.status = 'error';
          matchingDownload.usedRealDebrid = true;
          downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
          return downloads;
        });

        return;
      }
      currentDownloads.update((downloads) => {
        const matchingDownload = downloads.find((d) => d.id === localID + '')!!;
        matchingDownload.status = 'downloading';
        matchingDownload.id = downloadID;
        matchingDownload.usedRealDebrid = true;

        matchingDownload.downloadPath =
          getDownloadPath() + '/' + result.name + '/';
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });
      break;
    }
    case 'torrent': {
      if (!result.filename || !result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a filename for the torrent.',
        });
        return;
      }
      window.electronAPI.torrent
        .downloadTorrent(
          result.downloadURL,
          getDownloadPath() +
            '/' +
            result.name +
            '/' +
            (result.filename || result.downloadURL.split(/\\|\//).pop())
        )
        .then((id) => {
          htmlButton.textContent = 'Download';
          htmlButton.disabled = false;
          currentDownloads.update((downloads) => {
            return [
              ...downloads,
              {
                id,
                status: 'downloading',
                downloadPath: getDownloadPath() + '/' + result.name + '/',
                downloadSpeed: 0,
                progress: 0,
                usedRealDebrid: false,
                appID,
                downloadSize: 0,
                ...result,
              },
            ];
          });
        });
      break;
    }

    case 'magnet': {
      if (!result.filename || !result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a filename for the magnet link.',
        });
        return;
      }

      window.electronAPI.torrent
        .downloadMagnet(
          result.downloadURL,
          getDownloadPath() +
            '/' +
            result.name +
            '/' +
            (result.filename || result.downloadURL.split(/\\|\//).pop())
        )
        .then((id) => {
          htmlButton.textContent = 'Download';
          htmlButton.disabled = false;
          currentDownloads.update((downloads) => {
            return [
              ...downloads,
              {
                id,
                status: 'downloading',
                downloadPath: getDownloadPath() + '/' + result.name + '/',
                downloadSpeed: 0,
                progress: 0,
                usedRealDebrid: false,
                appID,
                downloadSize: 0,
                ...result,
              },
            ];
          });
        });
      break;
    }

    case 'direct': {
      if (!result.filename && !result.files) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a filename for the direct download.',
        });
        return;
      }

      let collectedFiles = [
        {
          path:
            getDownloadPath() +
            '/' +
            result.name +
            '/' +
            (result.filename || result.downloadURL?.split(/\\|\//).pop()),
          link: result.downloadURL!!,
        },
      ];
      if (result.files) {
        collectedFiles = result.files.map((file) => {
          return {
            path: getDownloadPath() + '/' + result.name + '/' + file.name,
            link: file.downloadURL,
          };
        });
      }

      window.electronAPI.ddl.download(collectedFiles).then((id) => {
        htmlButton.textContent = 'Download';
        htmlButton.disabled = false;
        currentDownloads.update((downloads) => {
          return [
            ...downloads,
            {
              id,
              status: 'downloading',
              downloadPath: getDownloadPath() + '/' + result.name + '/',
              downloadSpeed: 0,
              progress: 0,
              usedRealDebrid: false,
              appID,
              downloadSize: 0,
              ...result,
            },
          ];
        });
      });
      break;
    }
  }
}
type GameRequirements = {
  minimum: string;
  recommended: string;
};

type PackageGroup = {
  name: string;
  title: string;
  description: string;
  selection_text: string;
  save_text: string;
  display_type: number;
  is_recurring_subscription: string;
  subs: {
    packageid: number;
    percent_savings_text: string;
    percent_savings: number;
    option_text: string;
    option_description: string;
    can_get_free_license: string;
    is_free_license: boolean;
    price_in_cents_with_discount: number;
  }[];
};

type Category = {
  id: number;
  description: string;
};

type Genre = {
  id: string;
  description: string;
};

type Screenshot = {
  id: number;
  path_thumbnail: string;
  path_full: string;
};

type PlatformSupport = {
  windows: boolean;
  mac: boolean;
  linux: boolean;
};

type PriceOverview = {
  currency: string;
  initial: number;
  final: number;
  discount_percent: number;
  initial_formatted: string;
  final_formatted: string;
};

type Metacritic = {
  score: number;
  url: string;
};

export type GameData = {
  type: string;
  name: string;
  steam_appid: number;
  required_age: number;
  is_free: boolean;
  controller_support: string;
  dlc: number[];
  detailed_description: string;
  about_the_game: string;
  short_description: string;
  supported_languages: string;
  reviews: string;
  header_image: string;
  capsule_image: string;
  capsule_imagev5: string;
  website: string;
  pc_requirements: GameRequirements;
  mac_requirements: GameRequirements;
  linux_requirements: GameRequirements[];
  legal_notice: string;
  developers: string[];
  publishers: string[];
  price_overview: PriceOverview;
  packages: number[];
  package_groups: PackageGroup[];
  platforms: PlatformSupport;
  metacritic: Metacritic;
  categories: Category[];
  recommendations: {
    total: number;
  };
  genres: Genre[];
  screenshots: Screenshot[];
  release_date: {
    coming_soon: boolean;
    date: string;
  };
};

// Failed setup management functions
export async function loadFailedSetups() {
  try {
    if (!window.electronAPI.fs.exists('./failed-setups')) {
      window.electronAPI.fs.mkdir('./failed-setups');
      return;
    }

    const files = await window.electronAPI.fs.getFilesInDir('./failed-setups');
    const loadedSetups: FailedSetup[] = [];

    files.forEach((file: string) => {
      if (file.endsWith('.json')) {
        try {
          const content = window.electronAPI.fs.read(`./failed-setups/${file}`);
          const setupData = JSON.parse(content);
          loadedSetups.push(setupData);
        } catch (error) {
          console.error('Error loading failed setup file:', file, error);
        }
      }
    });

    failedSetups.set(loadedSetups);
  } catch (error) {
    console.error('Error loading failed setups:', error);
  }
}

export function removeFailedSetup(setupId: string) {
  try {
    const filePath = `./failed-setups/${setupId}.json`;
    if (window.electronAPI.fs.exists(filePath)) {
      window.electronAPI.fs.delete(filePath);
    }

    failedSetups.update((setups) =>
      setups.filter((setup) => setup.id !== setupId)
    );
  } catch (error) {
    console.error('Error removing failed setup:', error);
  }
}

export async function retryFailedSetup(failedSetup: FailedSetup) {
  try {
    console.log('Retrying setup for:', failedSetup.downloadInfo.name);

    const setupData = failedSetup.setupData;
    const addonSource = failedSetup.downloadInfo.addonSource;

    // Create a temporary download entry to show progress
    const tempId = Math.random().toString(36).substring(7);
    currentDownloads.update((downloads) => {
      return [
        ...downloads,
        {
          ...failedSetup.downloadInfo,
          id: tempId,
          status: 'completed' as const,
        },
      ];
    });

    // Attempt the setup again
    safeFetch(
      'setupApp',
      {
        addonID: addonSource,
        ...setupData,
      },
      {
        onLogs: (logs: string[]) => {
          document.dispatchEvent(
            new CustomEvent('setup:log', {
              detail: {
                id: tempId,
                log: logs,
              },
            })
          );
        },
        onProgress: (progress: number) => {
          document.dispatchEvent(
            new CustomEvent('setup:progress', {
              detail: {
                id: tempId,
                progress,
              },
            })
          );
        },
        consume: 'json',
      }
    )
      .then((result) => {
        window.electronAPI.app.insertApp(result);
        removeFailedSetup(failedSetup.id);
        // Update the temporary download entry to show completion
        currentDownloads.update((downloads) => {
          return downloads.map((download) => {
            if (download.id === tempId) {
              return {
                ...download,
                status: 'setup-complete' as const,
              };
            }
            return download;
          });
        });
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'success',
          message: `Successfully set up ${failedSetup.downloadInfo.name}`,
        });
      })
      .catch((error) => {
        console.error('Error retrying setup:', error);
        currentDownloads.update((downloads) => {
          return downloads.filter((download) => download.id !== tempId);
        });
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: `Failed to retry setup for ${failedSetup.downloadInfo.name}`,
        });
      });
  } catch (error) {
    console.error('Error retrying setup:', error);

    // Update retry count and save back to file
    const updatedSetup = {
      ...failedSetup,
      retryCount: failedSetup.retryCount + 1,
      error: error instanceof Error ? error.message : 'Unknown error',
    };

    window.electronAPI.fs.write(
      `./failed-setups/${failedSetup.id}.json`,
      JSON.stringify(updatedSetup, null, 2)
    );

    failedSetups.update((setups) =>
      setups.map((setup) =>
        setup.id === failedSetup.id ? updatedSetup : setup
      )
    );

    createNotification({
      id: Math.random().toString(36).substring(7),
      type: 'error',
      message: `Failed to retry setup for ${failedSetup.downloadInfo.name}`,
    });
  }
}

// Task management functions
export async function loadDeferredTasks() {
  try {
    const response = await window.electronAPI.app.request('getAllTasks', {});

    if (response.status === 200) {
      const tasks = response.data as ResponseDeferredTask[];
      deferredTasks.set(
        tasks.map((task: ResponseDeferredTask) => ({
          id: task.id,
          name: `Task ${task.id}`,
          description: 'Background task',
          addonOwner: task.addonOwner,
          status: task.finished
            ? task.failed
              ? 'error'
              : 'completed'
            : 'running',
          progress: task.progress || 0,
          failed: task.failed,
          logs: task.logs || [],
          timestamp: Date.now(),
          duration: undefined,
          error: task.failed || undefined,
          type: 'other',
        }))
      );
    }
  } catch (error) {
    console.error('Error loading deferred tasks:', error);
  }
}

export function startTaskPolling() {
  const pollInterval = setInterval(async () => {
    await loadDeferredTasks();
  }, 1000);

  return pollInterval;
}

export function stopTaskPolling(intervalId: ReturnType<typeof setInterval>) {
  clearInterval(intervalId);
}

export async function cancelTask(taskId: string) {
  try {
    // Note: Cancel functionality is not implemented in the defer API
    // Tasks cannot be cancelled once started
    console.warn('Task cancellation is not supported');

    // Optionally remove the task from the local state
    deferredTasks.update((tasks: DeferredTask[]) =>
      tasks.filter((task: DeferredTask) => task.id !== taskId)
    );
  } catch (error) {
    console.error('Error cancelling task:', error);
  }
}

export function clearCompletedTasks() {
  deferredTasks.update((tasks: DeferredTask[]) =>
    tasks.filter(
      (task: DeferredTask) =>
        task.status !== 'completed' &&
        task.status !== 'error' &&
        task.status !== 'cancelled'
    )
  );
}

export function clearAllTasks() {
  deferredTasks.update(() => []);
}
