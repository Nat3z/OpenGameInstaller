import type { OGIAddonConfiguration, SearchResult } from "ogi-addon";
import type { ConfigurationFile } from "ogi-addon/config";
import { createNotification, currentDownloads, notifications, failedSetups, deferredTasks, type FailedSetup, type DeferredTask } from "./store";
function getSecret() {
  const urlParams = new URLSearchParams(window.location.search);
  const addonSecret = urlParams.get('secret');
  return addonSecret;
}

interface ConsumableRequest extends RequestInit {
  consume?: 'json' | 'text';
  onProgress?: (progress: number) => void;
  onLogs?: (logs: string[]) => void;
}
export interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
  configTemplate: ConfigurationFile
}

export function getDownloadPath() {
  if (!window.electronAPI.fs.exists('./config/option/general.json')) {
    if (!window.electronAPI.fs.exists('./downloads')) window.electronAPI.fs.mkdir('./downloads');
    createNotification({
      message: 'Download path not set, using default path (./downloads)',
      id: 'download-path',
      type: 'info'
    })
    return "./downloads";
  }
  if (!window.electronAPI.fs.exists('./downloads')) window.electronAPI.fs.mkdir('./downloads');
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
    safeFetch('http://localhost:7654/addons').then(async (addons: ConfigTemplateAndInfo[]) => {
      // now configure each addon
      for (const addon of addons) {
        // check if file exists
        if (!window.electronAPI.fs.exists(`./config/${addon.id}.json`)) {
          // if it doesn't exist, create it with default values
          let defaultConfig: Record<string, number | boolean | string> = {};
          for (const key in addon.configTemplate) {
            defaultConfig[key] = addon.configTemplate[key].defaultValue as number | boolean | string;
          }
          window.electronAPI.fs.write(`./config/${addon.id}.json`, JSON.stringify(defaultConfig, null, 2));
        }
        const storedConfig = JSON.parse(window.electronAPI.fs.read(`./config/${addon.id}.json`));
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
          window.electronAPI.fs.write(`./config/${addon.id}.json`, JSON.stringify(defaultConfig, null, 2));
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
	console.log(url, options.body)
  return new Promise<any>((resolve, reject) => {
    // remove the functions on the options object
    const fetchOptions = { ...options };
    delete fetchOptions.consume;
    delete fetchOptions.onProgress;
    delete fetchOptions.onLogs;

    fetch(url, {
      ...fetchOptions,
      headers: {
        ...fetchOptions.headers,
        'Authorization': getSecret()!!,
				'Cache-Control': 'no-store'
      }
    }).then(async (response) => {
      if (!response.ok) {
				reject(response.statusText);
				return;
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
					if (taskResponse.status === 410) {
						reject('Addon is no longer connected');
						clearInterval(deferInterval);
					}
          if (taskResponse.status === 200) {
            clearInterval(deferInterval);
            if (!options || !options.consume || options.consume === 'json') return resolve(await taskResponse.json());
            else if (options.consume === 'text') return resolve(await taskResponse.text());
            else throw new Error('Invalid consume type');
          }
          if (taskResponse.status === 202) {
            const taskData = await taskResponse.json();
            if (options.onProgress) options.onProgress(taskData.progress);
            if (options.onLogs) options.onLogs(taskData.logs);
          }
        }, 100);
      }
      else {
        if (!options || !options.consume || options.consume === 'json') return resolve(await response.json());
        else if (options.consume === 'text') return resolve(await response.text());
        else throw new Error('Invalid consume type');
      }
    });
  });
}

export type SearchResultWithAddon = SearchResult & {
  addonSource: string
}
export async function startDownload(result: SearchResultWithAddon, event: MouseEvent) {
	if (event === null) return;
	if (event.target === null) return;
	const htmlButton = event.target as HTMLButtonElement;
	htmlButton.textContent = "Downloading...";
	htmlButton.disabled = true;
	let downloadType = result.downloadType;
	if (downloadType === "torrent" || downloadType === 'magnet') {
		const generalOptions = getConfigClientOption('general') as any;
		const torrentClient: "webtorrent" | "qbittorrent" | "real-debrid" = (generalOptions ? generalOptions.torrentClient : null) ?? 'webtorrent';
		if (torrentClient === 'real-debrid') {
			downloadType = 'real-debrid-' + downloadType;
		}
	}

	switch (downloadType) {
		case 'request': {
			// now startTheDownload but this way
			const randomID = Math.random().toString(36).substring(7);
			currentDownloads.update((downloads) => {
				return [...downloads, { 
					id: randomID, 
					status: 'requesting', 
					downloadPath: getDownloadPath() + "/" + result.name, 
					downloadSpeed: 0,
					progress: 0,
					usedRealDebrid: false,
					...result 
				}];
			});
			const response = await safeFetch(`http://localhost:7654/addons/${result.addonSource}/request-dl`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ appID: result.appID, info: result }),
				consume: 'json'
			});
			currentDownloads.update((downloads) => {
				return downloads.filter((d) => d.id !== randomID);
			});
			startDownload(response, event);
			break;
		}
		case 'real-debrid-magnet': {
			if (!result.downloadURL) {
				createNotification({
					id: Math.random().toString(36).substring(7),
					type: 'error',
					message: "Addon did not provide a magnet link."
				});
				return;
			}
			const worked = await window.electronAPI.realdebrid.updateKey();
			if (!worked) {
				createNotification({
					id: Math.random().toString(36).substring(7),
					type: 'error',
					message: "Please set your Real-Debrid API key in the settings."
				});
				return;
			}
			// get the first host
			const hosts = await window.electronAPI.realdebrid.getHosts();	
			const localID = Math.floor(Math.random() * 1000000);
			currentDownloads.update((downloads) => {
				return [...downloads, { 
					id: '' + localID, 
					status: 'rd-downloading', 
					downloadPath: getDownloadPath() + "/" + result.name, 
					downloadSpeed: 0,
					usedRealDebrid: true,
					progress: 0,
					...result 
				}];
			});
			// add magnet link
			const magnetLink = await window.electronAPI.realdebrid.addMagnet(result.downloadURL, hosts[0]);
			const isReady = await window.electronAPI.realdebrid.isTorrentReady(magnetLink.id);
			if (!isReady) {
				window.electronAPI.realdebrid.selectTorrent(magnetLink.id);
				await new Promise<void>((resolve) => {
					const interval = setInterval(async () => {
						const isReady = await window.electronAPI.realdebrid.isTorrentReady(magnetLink.id);
						if (isReady) {
							clearInterval(interval);
							resolve();
						}
					}, 3000);
				});
			}


			const torrentInfo = await window.electronAPI.realdebrid.getTorrentInfo(magnetLink.id);
			const download = await window.electronAPI.realdebrid.unrestrictLink(torrentInfo.links[0]);

			if (download === null) {
				createNotification({
					id: Math.random().toString(36).substring(7),
					type: 'error',
					message: "Failed to unrestrict the link."
				});
				return;
			}
			const downloadID = await window.electronAPI.ddl.download([ { link: download.download, path: getDownloadPath() + "/" + download.filename } ]);
			if (downloadID === null) {
				if (htmlButton) {
					htmlButton.textContent = "Download";
					htmlButton.disabled = false;
				}
				currentDownloads.update((downloads) => {
					const matchingDownload = downloads.find((d) => d.id === localID + '')!!;
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

				matchingDownload.downloadPath = getDownloadPath() + "/" + download.filename;
				downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
				return downloads;
			});
			break;
		}
		case "real-debrid-torrent": {
			if (!result.name || !result.downloadURL) {
				createNotification({
					id: Math.random().toString(36).substring(7),
					type: 'error',
					message: "Addon did not provide a name for the torrent."
				});
				return;
			}

			const worked = await window.electronAPI.realdebrid.updateKey();
			if (!worked) {
				notifications.update((notifications) => [...notifications, { id: Math.random().toString(36).substring(7), type: 'error', message: "Please set your Real-Debrid API key in the settings." }]);
				return;
			}
			// add torrent link
			const localID = Math.floor(Math.random() * 1000000);
			currentDownloads.update((downloads) => {
				return [...downloads, { 
					id: '' + localID, 
					status: 'rd-downloading', 
					downloadPath: getDownloadPath() + "/" + result.name, 
					downloadSpeed: 0,
					usedRealDebrid: true,
					progress: 0,
					...result 
				}];
			});
			const torrent = await window.electronAPI.realdebrid.addTorrent(result.downloadURL);
			const isReady = await window.electronAPI.realdebrid.isTorrentReady(torrent.id);
			if (!isReady) {
				window.electronAPI.realdebrid.selectTorrent(torrent.id);
				await new Promise<void>((resolve) => {
					const interval = setInterval(async () => {
						const isReady = await window.electronAPI.realdebrid.isTorrentReady(torrent.id);
						if (isReady) {
							clearInterval(interval);
							resolve();
						}
					}, 3000);
				});
			}


			const torrentInfo = await window.electronAPI.realdebrid.getTorrentInfo(torrent.id);
			// currently only supporting the first link
			const download = await window.electronAPI.realdebrid.unrestrictLink(torrentInfo.links[0]);
			if (download === null) {
				createNotification({
					id: Math.random().toString(36).substring(7),
					type: 'error',
					message: "Failed to unrestrict the link."
				});
				return;
			}

			const downloadID = await window.electronAPI.ddl.download([ { link: download.download, path: getDownloadPath() + "/" + download.filename } ]);
			if (downloadID === null) {
				if (htmlButton) {
					htmlButton.textContent = "Download";
					htmlButton.disabled = false;
				}
				currentDownloads.update((downloads) => {
					const matchingDownload = downloads.find((d) => d.id === localID + '')!!;
					matchingDownload.status = 'error';
					matchingDownload.usedRealDebrid = true;
					downloads[downloads.indexOf(matchingDownload)] = matchingDownload;
					return downloads;
				});

				return;
			}
			currentDownloads.update((downloads) => {
				const matchingDownload = downloads.find((d) => d.id === localID + '')!!
				matchingDownload.status = 'downloading';
				matchingDownload.id = downloadID;
				matchingDownload.usedRealDebrid = true;

				matchingDownload.downloadPath = getDownloadPath() + "/" + download.filename;
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
						message: "Addon did not provide a filename for the torrent."
					});
				return;
			}
			const downloadID = await window.electronAPI.torrent.downloadTorrent(result.downloadURL, getDownloadPath() + "/" + (result.filename || result.downloadURL.split(/\\|\//).pop()));
			if (downloadID === null) {
				htmlButton.textContent = "Download";
				htmlButton.disabled = false;
				return;
			}
			currentDownloads.update((downloads) => {
				return [...downloads, { 
					id: downloadID, 
					status: 'downloading', 
					downloadPath: getDownloadPath() + "/" + result.filename + ".torrent", 
					downloadSpeed: 0,
					progress: 0,
					usedRealDebrid: false,
					...result 
				}];
			});
			break;
		}

		case 'magnet': {
			if (!result.filename || !result.downloadURL) {
				createNotification({
					id: Math.random().toString(36).substring(7),
					type: 'error',
					message: "Addon did not provide a filename for the magnet link."
				});
				return;
			}

			const downloadID = await window.electronAPI.torrent.downloadMagnet(result.downloadURL!!, getDownloadPath() + "/" + result.filename!!);
			if (downloadID === null) {
				htmlButton.textContent = "Download";
				htmlButton.disabled = false;
				return;
			}
			currentDownloads.update((downloads) => {
				return [...downloads, { 
					id: downloadID, 
					status: 'downloading', 
					downloadPath: getDownloadPath() + "/" + result.filename + ".torrent", 
					downloadSpeed: 0,
					progress: 0,
					usedRealDebrid: false,
					...result 
				}];
			});
			break;
		}

		case "direct": {
			if (!result.filename && !result.files) {
					createNotification({
						id: Math.random().toString(36).substring(7),
						type: 'error',
						message: "Addon did not provide a filename for the direct download."
					});
				return;
			}

			let collectedFiles = [ { path: getDownloadPath() + "/" + result.filename!!, link: result.downloadURL!! } ];
			if (result.files) {
				collectedFiles = result.files.map((file) => {
					return { path: getDownloadPath() + "/" + file.name, link: file.downloadURL };
				});
			}

			const downloadID = await window.electronAPI.ddl.download(collectedFiles);
			if (downloadID === null) {
				htmlButton.textContent = "Download";
				htmlButton.disabled = false;
				return;
			}
			currentDownloads.update((downloads) => {
				return [...downloads, { 
					id: downloadID, 
					status: 'downloading',
					downloadPath: (result.files ? getDownloadPath() + "/" : getDownloadPath() + "/" + result.filename), 
					downloadSpeed: 0,
					usedRealDebrid: false,
					progress: 0,
					...result 
				}];
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
    
    failedSetups.update((setups) => setups.filter(setup => setup.id !== setupId));
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
      return [...downloads, {
        ...failedSetup.downloadInfo,
        id: tempId,
        status: 'completed' as const
      }];
    });
    
    // Attempt the setup again
    safeFetch(`http://localhost:7654/addons/${addonSource}/setup-app`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(setupData),
      onLogs: (log) => {
        document.dispatchEvent(new CustomEvent('setup:log', {
          detail: {
            id: tempId,
            log
          }
        }));
      },
      onProgress: (progress) => {
        document.dispatchEvent(new CustomEvent('setup:progress', {
          detail: {
            id: tempId,
            progress
          }
        }));
      },
      consume: "json"
    }).then((result) => {
      window.electronAPI.app.insertApp(result);
      removeFailedSetup(failedSetup.id);
			// Update the temporary download entry to show completion
			currentDownloads.update((downloads) => {
				return downloads.map((download) => {
					if (download.id === tempId) {
						return {
							...download,
							status: 'setup-complete' as const
						};
					}
					return download;
				});
			});
			createNotification({
				id: Math.random().toString(36).substring(7),
				type: 'success',
				message: `Successfully set up ${failedSetup.downloadInfo.name}`
			});
    }).catch((error) => {
      console.error('Error retrying setup:', error);
			currentDownloads.update((downloads) => {
				return downloads.filter((download) => download.id !== tempId);
			});
			createNotification({
				id: Math.random().toString(36).substring(7),
				type: 'error',
				message: `Failed to retry setup for ${failedSetup.downloadInfo.name}`
			});
    });
    
    
    
  } catch (error) {
    console.error('Error retrying setup:', error);
    
    // Update retry count and save back to file
    const updatedSetup = {
      ...failedSetup,
      retryCount: failedSetup.retryCount + 1,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
    
    window.electronAPI.fs.write(`./failed-setups/${failedSetup.id}.json`, JSON.stringify(updatedSetup, null, 2));
    
    failedSetups.update((setups) => 
      setups.map(setup => setup.id === failedSetup.id ? updatedSetup : setup)
    );
    
    createNotification({
      id: Math.random().toString(36).substring(7),
      type: 'error',
      message: `Failed to retry setup for ${failedSetup.downloadInfo.name}`
    });
  }
}

// Task management functions
export async function loadDeferredTasks() {
  try {
    const response = await fetch('http://localhost:7654/defer', {
      headers: {
        'Authorization': getSecret()!!,
        'Cache-Control': 'no-store'
      }
    });
    
    if (response.ok) {
      const tasks = await response.json();
      deferredTasks.set(tasks.map((task: any) => ({
        id: task.id,
        name: `Task ${task.id}`,
        description: task.failureMessage || 'Background task',
        addonOwner: task.addonOwner,
        status: task.finished ? (task.failureMessage ? 'error' : 'completed') : 'running',
        progress: task.progress || 0,
        logs: task.logs || [],
        timestamp: Date.now(),
        duration: undefined,
        error: task.failureMessage,
        type: 'other'
      })));
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
    const response = await fetch(`http://localhost:7654/defer/${taskId}/cancel`, {
      method: 'POST',
      headers: {
        'Authorization': getSecret()!!
      }
    });
    
    if (response.ok) {
      deferredTasks.update((tasks: DeferredTask[]) => 
        tasks.map((task: DeferredTask) => 
          task.id === taskId 
            ? { ...task, status: 'cancelled' as const }
            : task
        )
      );
    }
  } catch (error) {
    console.error('Error cancelling task:', error);
  }
}

export function clearCompletedTasks() {
  deferredTasks.update((tasks: DeferredTask[]) => 
    tasks.filter((task: DeferredTask) => 
      task.status !== 'completed' && 
      task.status !== 'error' && 
      task.status !== 'cancelled'
    )
  );
}

export function clearAllTasks() {
  deferredTasks.update(() => []);
}