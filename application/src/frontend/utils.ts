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
  type DownloadStatusAndInfo,
  removedTasks,
  setupLogs,
} from './store';
import type { ResponseDeferredTask } from '../electron/server/api/defer.js';

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
            if (options.onFailed)
              options.onFailed('Task not found when deferring.');
            clearInterval(deferInterval);
          } else if (taskResponse.status === 410) {
            reject('Addon is no longer connected');
            if (options.onFailed)
              options.onFailed('Addon is no longer connected');
            clearInterval(deferInterval);
          } else if (taskResponse.status !== 200) {
            console.log('Task failed', taskResponse);
            if (options.onFailed)
              options.onFailed(taskResponse.error ?? 'Task failed');
            clearInterval(deferInterval);
            reject(taskResponse.error ?? 'Task failed');
            return;
          }
          if (
            taskResponse.data &&
            taskResponse.data.data &&
            taskResponse.data.data.progress === undefined
          ) {
            // Task is completed
            clearInterval(deferInterval);
            if (!options || !options.consume || options.consume === 'json')
              return resolve(
                JSON.parse(JSON.stringify(taskResponse.data.data))
              );
            else if (options.consume === 'text')
              return resolve(taskResponse.data.data);
            else throw new Error('Invalid consume type');
          }
          if (taskResponse.data) {
            // Task is still running
            const taskData: {
              progress: number;
              logs: string[];
              failed: string | undefined;
            } = taskResponse.data;
            if (options.onProgress && taskData.progress !== undefined)
              options.onProgress(taskData.progress);
            if (options.onLogs && taskData.logs !== undefined)
              options.onLogs(taskData.logs);
            if (options.onFailed && taskData.failed)
              options.onFailed(taskData.failed);
          }
        }, 50);
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
  capsuleImage: string;
  coverImage: string;
  storefront: string;
};

function listenUntilDownloadReady() {
  let state: { [id: string]: Partial<DownloadStatusAndInfo> } = {};
  const updateState = (e: Event) => {
    if (e instanceof CustomEvent) {
      if (e.detail) {
        state[e.detail.id] = e.detail as Partial<DownloadStatusAndInfo>;
      }
    }
  };
  document.addEventListener('ddl:download-progress', updateState);

  return {
    flush: () => {
      document.removeEventListener('ddl:download-progress', updateState);
      return state;
    },
  };
}
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
      // Create a local ID for tracking, similar to real-debrid cases
      const localID = Math.floor(Math.random() * 1000000);
      currentDownloads.update((downloads) => {
        return [
          ...downloads,
          {
            id: '' + localID,
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
          info: JSON.parse(JSON.stringify(result)),
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
              const matchingDownload = downloads.find(
                (d) => d.id === localID + ''
              )!!;
              matchingDownload.status = 'error';
              matchingDownload.error = error;
              downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
              return downloads;
            });
          },
        }
      );

      console.log('Request response:', response);

      // Merge response with original context
      const updatedResult = {
        ...response,
        addonSource: result.addonSource,
        capsuleImage: result.capsuleImage,
        coverImage: result.coverImage,
        storefront: result.storefront,
      };

      // Remove the temporary requesting download
      currentDownloads.update((downloads) => {
        return downloads.filter((d) => d.id !== localID + '');
      });

      // Reset button state before recursive call
      htmlButton.textContent = 'Downloading...';
      htmlButton.disabled = true;

      // Recursively call startDownload with the resolved result
      return await startDownload(updatedResult, appID, event);
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

      // Temporarily register an event listener to store any download updates so that we can match our download to the correct downloadID
      const { flush } = listenUntilDownloadReady();

      const downloadID = await window.electronAPI.ddl.download([
        {
          link: download.download,
          path: getDownloadPath() + '/' + result.name + '/' + result.filename,
        },
      ]);
      const updatedState = flush();
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

        if (
          updatedState[downloadID] &&
          updatedState[downloadID].queuePosition
        ) {
          matchingDownload.queuePosition =
            updatedState[downloadID].queuePosition;
        }
        matchingDownload.downloadURL = download.download;
        matchingDownload.originalDownloadURL = result.downloadURL; // Store original magnet URL
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

      // Temporarily register an event listener to store any download updates so that we can match our download to the correct downloadID

      const { flush } = listenUntilDownloadReady();
      const downloadID = await window.electronAPI.ddl.download([
        {
          link: download.download,
          path: getDownloadPath() + '/' + result.name + '/' + result.filename,
        },
      ]);
      const updatedState = flush();
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

        if (updatedState[downloadID]) {
          matchingDownload.queuePosition =
            updatedState[downloadID].queuePosition ?? 999;
        }
        matchingDownload.downloadURL = download.download;
        matchingDownload.originalDownloadURL = result.downloadURL; // Store original torrent URL
        downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
        return downloads;
      });
      break;
    }
    case 'torrent': {
      if (!result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a torrent file.',
        });
        return;
      }

      // Generate a safe filename fallback for torrent files
      let filename = result.filename;
      if (!filename) {
        // Try to extract filename from URL or use a generic name
        const urlParts = result.downloadURL.split(/[\/\\]/);
        const lastPart = urlParts[urlParts.length - 1];
        if (lastPart && lastPart.includes('.')) {
          filename = lastPart;
        } else {
          // Use the result name or a generic fallback
          filename = result.name || 'torrent_download';
        }
        // Sanitize filename to remove invalid characters and limit length
        filename = filename.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
      }

      const downloadPath =
        getDownloadPath() + '/' + result.name + '/' + filename;

      window.electronAPI.torrent
        .downloadTorrent(result.downloadURL, downloadPath)
        .then((id) => {
          if (id === null) {
            createNotification({
              id: Math.random().toString(36).substring(7),
              type: 'error',
              message: 'Failed to download torrent.',
            });
            return;
          }
          htmlButton.textContent = 'Downloading...';
          htmlButton.disabled = true;
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
                originalDownloadURL: result.downloadURL, // Store original URL for resume
                ...result,
              },
            ];
          });
        });
      break;
    }

    case 'magnet': {
      if (!result.downloadURL) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: 'Addon did not provide a magnet link.',
        });
        return;
      }

      // Generate a safe filename fallback for magnet links
      let filename = result.filename;
      if (!filename) {
        // For magnet links, extract name from the magnet URI or use a generic name
        const magnetMatch = result.downloadURL.match(/dn=([^&]*)/);
        if (magnetMatch) {
          filename = decodeURIComponent(magnetMatch[1]);
        } else {
          // Use the result name or a generic fallback
          filename = result.name || 'torrent_download';
        }
        // Sanitize filename to remove invalid characters and limit length
        filename = filename.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
      }

      const downloadPath =
        getDownloadPath() + '/' + result.name + '/' + filename;

      window.electronAPI.torrent
        .downloadMagnet(result.downloadURL, downloadPath)
        .then((id) => {
          if (id === null) {
            createNotification({
              id: Math.random().toString(36).substring(7),
              type: 'error',
              message: 'Failed to download torrent.',
            });
            return;
          }
          htmlButton.textContent = 'Downloading...';
          htmlButton.disabled = true;
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
                queuePosition: 999,
                appID,
                downloadSize: 0,
                originalDownloadURL: result.downloadURL, // Store original URL for resume
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
            // remove proxy
            headers: JSON.parse(JSON.stringify(file.headers || {})),
          };
        });
      }

      const { flush } = listenUntilDownloadReady();

      window.electronAPI.ddl.download(collectedFiles).then((id) => {
        htmlButton.textContent = 'Downloading...';
        htmlButton.disabled = true;
        const updatedState = flush();
        console.log('updatedState', updatedState);
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
              originalDownloadURL: result.downloadURL, // Store original URL for resume
              queuePosition: updatedState[id]?.queuePosition ?? 999,
              files: result.files, // Store files info for multi-part downloads
              ...result,
            },
          ];
        });
      });
      break;
    }
  }
}

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
  const updateRetry = (newSetup: FailedSetup, error: string) => {
    const updatedSetup = {
      ...newSetup,
      retryCount: newSetup.retryCount + 1,
      error: error as string,
    };

    window.electronAPI.fs.write(
      `./failed-setups/${newSetup.id}.json`,
      JSON.stringify(updatedSetup, null, 2)
    );

    failedSetups.update((setups) =>
      setups.map((setup) => (setup.id === newSetup.id ? updatedSetup : setup))
    );
  };

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
    if (failedSetup.should === 'call-unrar') {
      console.log(
        'Unrarring RAR file: ',
        failedSetup.downloadInfo.downloadPath.replace(/(\/|\\)$/g, '') +
          '/' +
          failedSetup.downloadInfo.filename,
        'to',
        getDownloadPath() + '/' + failedSetup.downloadInfo.name
      );
      const extractedDir = await window.electronAPI.fs.unrar({
        outputDir:
          failedSetup.downloadInfo.downloadPath.replace(/(\/|\\)$/g, '') +
          '/' +
          failedSetup.downloadInfo.name,
        rarFilePath:
          failedSetup.downloadInfo.downloadPath.replace(/(\/|\\)$/g, '') +
          '/' +
          failedSetup.downloadInfo.filename,
      });
      setupData.path = extractedDir;
      // delete the rar file
      console.log('Deleting RAR file: ', failedSetup.downloadInfo.downloadPath);
      window.electronAPI.fs.delete(failedSetup.downloadInfo.downloadPath);
      console.log('RAR file deleted');
      failedSetup.downloadInfo.downloadPath = extractedDir;
      failedSetup.setupData.path = extractedDir;
      failedSetup.should = 'call-addon';
    }

    // now add to setup logs
    setupLogs.update((logs) => ({
      ...logs,
      [tempId]: {
        downloadId: tempId,
        logs: [],
        progress: 0,
        isActive: true,
      },
    }));

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
      .then(
        (
          result: Omit<
            LibraryInfo,
            | 'capsuleImage'
            | 'coverImage'
            | 'name'
            | 'appID'
            | 'storefront'
            | 'addonsource'
          >
        ) => {
          window.electronAPI.app.insertApp({
            ...result,
            capsuleImage: failedSetup.downloadInfo.capsuleImage,
            coverImage: failedSetup.downloadInfo.coverImage,
            name: failedSetup.downloadInfo.name,
            appID: failedSetup.downloadInfo.appID,
            storefront: failedSetup.downloadInfo.storefront,
            addonsource: failedSetup.downloadInfo.addonSource,
          });
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
        }
      )
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

        updateRetry(failedSetup, error);
      });
  } catch (error: unknown) {
    console.error('Error retrying setup:', error);

    createNotification({
      id: Math.random().toString(36).substring(7),
      type: 'error',
      message: `Failed to retry setup for ${failedSetup.downloadInfo.name}`,
    });

    updateRetry(failedSetup, error as string);
  }
}

// Task management functions
export async function loadDeferredTasks(removedTasks: string[] = []) {
  try {
    const response = await window.electronAPI.app.request('getAllTasks', {});

    if (response.status === 200) {
      const tasks = response.data as ResponseDeferredTask[];
      deferredTasks.set(
        tasks
          .filter(
            (task: ResponseDeferredTask) => !removedTasks.includes(task.id)
          )
          .map((task: ResponseDeferredTask) => ({
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

export function clearAllTasks(tasks: string[]) {
  removedTasks.set(tasks);
  deferredTasks.update(() => []);
}

// Download management utility functions
export function updateDownloadStatus(
  downloadID: string,
  updates: Partial<DownloadStatusAndInfo>
) {
  currentDownloads.update((downloads) => {
    return downloads.map((download) => {
      if (download.id === downloadID) {
        const updatedDownload = { ...download, ...updates };

        // Initialize setup logs when status changes to 'completed' (setup phase)
        if (updates.status === 'completed' && download.status !== 'completed') {
          setupLogs.update((logs) => ({
            ...logs,
            [downloadID]: {
              downloadId: downloadID,
              logs: [],
              progress: 0,
              isActive: true,
            },
          }));
        }

        return updatedDownload;
      }
      return download;
    });
  });
}

export function getDownloadItem(
  downloadID: string
): DownloadStatusAndInfo | undefined {
  let foundItem: DownloadStatusAndInfo | undefined;
  currentDownloads.update((downloads) => {
    return downloads.map((download) => {
      if (download.id === downloadID) {
        foundItem = download;
        return download;
      }
      return download;
    });
  });
  return foundItem;
}

// Download state management - mimicking direct-download.ts approach
interface PausedDownloadState {
  id: string;
  downloadInfo: DownloadStatusAndInfo;
  pausedAt: number;
  originalDownloadURL?: string;
  files?: any[];
}

// Store paused download states - similar to downloadStates in direct-download.ts
const pausedDownloadStates: Map<string, PausedDownloadState> = new Map();

// Pause/Resume functionality - redesigned to mimic direct-download.ts
export async function pauseDownload(downloadId: string): Promise<boolean> {
  try {
    const download = getDownloadItem(downloadId);
    if (!download) {
      console.log('No download found for ID:', downloadId);
      return false;
    }

    console.log('Pausing download:', downloadId, download.name);

    // Create paused state - similar to how direct-download.ts stores download states
    const pausedState: PausedDownloadState = {
      id: downloadId,
      downloadInfo: { ...download },
      pausedAt: Date.now(),
      originalDownloadURL: download.originalDownloadURL || download.downloadURL,
      files: download.files,
    };

    // Store the paused state in memory
    pausedDownloadStates.set(downloadId, pausedState);

    // Update UI status first
    updateDownloadStatus(downloadId, { status: 'paused' });

    // Call appropriate pause method based on download type
    let pauseResult = false;
    if (download.downloadType === 'direct' || download.usedRealDebrid) {
      try {
        await window.electronAPI.ddl.pauseDownload(downloadId);
        pauseResult = true;
      } catch (error) {
        console.error('Failed to pause direct download:', error);
        pauseResult = false;
      }
    } else if (
      download.downloadType === 'torrent' ||
      download.downloadType === 'magnet'
    ) {
      try {
        await window.electronAPI.torrent.pauseDownload(downloadId);
        pauseResult = true;
      } catch (error) {
        console.error('Failed to pause torrent download:', error);
        pauseResult = false;
      }
    }

    if (pauseResult) {
      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'info',
        message: `Paused download: ${download.name}`,
      });
      return true;
    } else {
      // If pause failed, remove from paused states
      pausedDownloadStates.delete(downloadId);
      updateDownloadStatus(downloadId, { status: 'downloading' });
      return false;
    }
  } catch (error) {
    console.error('Error pausing download:', error);
    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: 'Failed to pause download',
    });
    return false;
  }
}

export async function resumeDownload(downloadId: string): Promise<boolean> {
  try {
    console.log('Attempting to resume download:', downloadId);

    // Get paused state - similar to how direct-download.ts retrieves states
    const pausedState = pausedDownloadStates.get(downloadId);
    if (!pausedState) {
      console.log('No paused download state found for', downloadId);
      return false;
    }

    const download = pausedState.downloadInfo;
    console.log(
      'Resuming download:',
      download.name,
      'Type:',
      download.downloadType
    );

    // Update UI status first
    updateDownloadStatus(downloadId, { status: 'downloading' });

    // Try to resume the download
    let resumeResult = false;
    if (download.downloadType === 'direct' || download.usedRealDebrid) {
      try {
        await window.electronAPI.ddl.resumeDownload(downloadId);
        resumeResult = true;
      } catch (error) {
        console.error('Failed to resume direct download:', error);
        resumeResult = false;
      }
    } else if (
      download.downloadType === 'torrent' ||
      download.downloadType === 'magnet'
    ) {
      try {
        await window.electronAPI.torrent.resumeDownload(downloadId);
        resumeResult = true;
      } catch (error) {
        console.error('Failed to resume torrent download:', error);
        resumeResult = false;
      }
    }

    if (resumeResult) {
      // Resume successful - clean up paused state
      pausedDownloadStates.delete(downloadId);

      createNotification({
        id: Math.random().toString(36).substring(2, 9),
        type: 'info',
        message: `Resumed download: ${download.name}`,
      });
      return true;
    } else {
      // Resume failed - attempt restart
      console.log('In-place resume failed, attempting restart...');
      return await restartDownload(pausedState);
    }
  } catch (error) {
    console.error('Error resuming download:', error);

    updateDownloadStatus(downloadId, {
      status: 'error',
      error:
        error instanceof Error ? error.message : 'Failed to resume download',
    });

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message:
        error instanceof Error ? error.message : 'Failed to resume download',
    });
    return false;
  }
}

// Restart download functionality - simplified and focused
async function restartDownload(
  pausedState: PausedDownloadState
): Promise<boolean> {
  try {
    const download = pausedState.downloadInfo;
    console.log('Restarting download:', download.name);

    // Generate new download ID to avoid conflicts
    const newDownloadId = Math.random().toString(36).substring(7);

    // Clean up old paused state
    pausedDownloadStates.delete(pausedState.id);

    // Update the download with new ID
    updateDownloadStatus(pausedState.id, {
      id: newDownloadId,
      status: 'downloading',
      progress: download.progress || 0,
    });

    let newActualDownloadId: string;

    // Restart based on download type
    if (download.downloadType === 'direct' || download.usedRealDebrid) {
      newActualDownloadId = await restartDirectDownload(download);
    } else if (
      download.downloadType === 'torrent' ||
      download.downloadType === 'magnet'
    ) {
      newActualDownloadId = await restartTorrentDownload(download);
    } else {
      throw new Error(`Unsupported download type: ${download.downloadType}`);
    }

    // Update with the actual download ID returned by the backend
    updateDownloadStatus(newDownloadId, { id: newActualDownloadId });

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'info',
      message: `Restarted download: ${download.name}`,
    });

    return true;
  } catch (error) {
    console.error('Error restarting download:', error);

    updateDownloadStatus(pausedState.id, {
      status: 'error',
      error: 'Failed to restart download',
    });

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: `Failed to restart download: ${pausedState.downloadInfo.name}`,
    });

    return false;
  }
}

async function restartDirectDownload(
  download: DownloadStatusAndInfo
): Promise<string> {
  const originalUrl = download.originalDownloadURL || download.downloadURL;
  if (!originalUrl) {
    throw new Error('No download URL available for restart');
  }

  let files: {
    link: string;
    path: string;
    headers?: Record<string, string>;
  }[] = [];

  if (download.files && download.files.length > 0) {
    // Multi-part download
    files = download.files.map((file: any) => ({
      link: file.downloadURL,
      path: getDownloadPath() + '/' + download.name + '/' + file.name,
      headers: file.headers,
    }));
  } else {
    // Single file download
    const filename =
      download.filename || originalUrl.split(/\\|\//).pop() || 'download';
    files = [
      {
        link: originalUrl,
        path: getDownloadPath() + '/' + download.name + '/' + filename,
      },
    ];
  }

  console.log('Restarting direct download with files:', files);
  return await window.electronAPI.ddl.download(files);
}

async function restartTorrentDownload(
  download: DownloadStatusAndInfo
): Promise<string> {
  const originalUrl = download.originalDownloadURL || download.downloadURL;
  if (!originalUrl) {
    throw new Error('No torrent URL available for restart');
  }

  // Generate a safe filename fallback
  let filename = download.filename;
  if (!filename) {
    if (download.downloadType === 'magnet') {
      // For magnet links, extract name from the magnet URI or use a generic name
      const magnetMatch = originalUrl.match(/dn=([^&]*)/);
      if (magnetMatch) {
        filename = decodeURIComponent(magnetMatch[1]);
      } else {
        filename = download.name || 'torrent_download';
      }
    } else {
      // For torrent files, try to extract filename from URL
      const urlParts = originalUrl.split(/[\/\\]/);
      const lastPart = urlParts[urlParts.length - 1];
      if (lastPart && lastPart.includes('.')) {
        filename = lastPart;
      } else {
        filename = download.name || 'torrent_download';
      }
    }
    // Sanitize filename to remove invalid characters and limit length
    filename = filename.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
  }

  const path = getDownloadPath() + '/' + download.name + '/' + filename;

  console.log('Restarting torrent download:', originalUrl, 'to path:', path);

  if (download.downloadType === 'torrent') {
    return await window.electronAPI.torrent.downloadTorrent(originalUrl, path);
  } else if (download.downloadType === 'magnet') {
    return await window.electronAPI.torrent.downloadMagnet(originalUrl, path);
  } else {
    throw new Error(
      `Unsupported torrent download type: ${download.downloadType}`
    );
  }
}

export function cancelPausedDownload(downloadId: string) {
  try {
    const pausedState = pausedDownloadStates.get(downloadId);
    if (!pausedState) return;

    // Remove from memory only (no file persistence)
    pausedDownloadStates.delete(downloadId);

    // Remove from current downloads
    currentDownloads.update((downloads) => {
      return downloads.filter((d) => d.id !== downloadId);
    });

    // send to the ipc to cancel the download
    window.electronAPI.ddl.abortDownload(downloadId);

    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'info',
      message: `Cancelled download: ${pausedState.downloadInfo.name}`,
    });
  } catch (error) {
    console.error('Error cancelling paused download:', error);
    createNotification({
      id: Math.random().toString(36).substring(2, 9),
      type: 'error',
      message: 'Failed to cancel download',
    });
  }
}
