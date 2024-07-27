<script lang="ts">
  import { onMount } from "svelte";
  import { fetchAddonsWithConfigure, getConfigClientOption, getDownloadPath, safeFetch } from "../utils";
  import type { OGIAddonConfiguration, SearchResult } from "ogi-addon";
  import type { ConfigurationFile } from "ogi-addon/config";
  import { createNotification, currentDownloads, notifications } from "../store";
	interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
    configTemplate: ConfigurationFile
  }
	let addons: ConfigTemplateAndInfo[] = [];
  onMount(() => {
    safeFetch("http://localhost:7654/addons").then((data) => {
      addons = data;
    });
  });

	type SearchResultWithAddon = SearchResult & {
		addonSource: string
	}

	let results: SearchResultWithAddon[] = [];

	let loadingResults = false;
	async function search() {
		// fetch addons first
		loadingResults = true;
		addons = await fetchAddonsWithConfigure();
		results = [];
		const search = document.getElementById("search")!! as HTMLInputElement;
		const query = search.value = search.value.toLowerCase();
		loadingResults = true;
		for (const addon of addons) {
			safeFetch("http://localhost:7654/addons/" + addon.id + "/search?query=" + query, { consume: 'json' }).then((data) => {
				loadingResults = false;
				results = [ ...results, 
					...data.map((result: SearchResult) => {
						return {
							...result,
							addonSource: addon.id
						}
					})
				 ];
			});
		}
	}

	async function startDownload(result: SearchResultWithAddon, event: MouseEvent) {
		if (event === null) return;
		if (event.target === null) return;
		const htmlButton = (event.target as HTMLElement).closest('button')!!;
		htmlButton.querySelector('[data-dwtext]')!!.textContent = "Downloading...";
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
			case 'real-debrid-magnet': {
				if (!result.downloadURL) {
					createNotification({
						id: Math.random().toString(36).substring(7),
						type: 'error',
						message: "Addon did not provide a magnet link."
					});
					return;
				}
				const worked = window.electronAPI.realdebrid.updateKey();
				if (!worked) {
					createNotification({
						id: Math.random().toString(36).substring(7),
						type: 'error',
						message: "Please set your Real-Debrid API key in the settings."
					});
					return;
				}
				// get the first host
				const hosts = window.electronAPI.realdebrid.getHosts();	
				// add magnet link
				const magnetLink = window.electronAPI.realdebrid.addMagnet(result.downloadURL, hosts[0]);
				const isReady = window.electronAPI.realdebrid.isTorrentReady(magnetLink.id);
				if (!isReady) {
					window.electronAPI.realdebrid.selectTorrent(magnetLink.id);
					await new Promise<void>((resolve) => {
						const interval = setInterval(async () => {
							const isReady = await window.electronAPI.realdebrid.isTorrentReady(magnetLink.id);
							if (isReady) {
								clearInterval(interval);
								resolve();
							}
						}, 1000);
					});
				}


				const torrentInfo = await window.electronAPI.realdebrid.getTorrentInfo(magnetLink.id);
				const download = window.electronAPI.realdebrid.unrestrictLink(torrentInfo.links[0]);

				if (download === null) {
					createNotification({
						id: Math.random().toString(36).substring(7),
						type: 'error',
						message: "Failed to unrestrict the link."
					});
					return;
				}
				const downloadID = await window.electronAPI.ddl.download([ { link: download.download, path: getDownloadPath() + "\\" + download.filename } ]);
				currentDownloads.update((downloads) => {
					return [...downloads, { 
						id: downloadID, 
						status: 'downloading', 
						downloadPath: getDownloadPath() + "\\" + download.filename, 
						downloadSpeed: 0,
						progress: 0,
						usedRealDebrid: true,
						...result 
					}];
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

				const worked = window.electronAPI.realdebrid.updateKey();
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
						downloadPath: getDownloadPath() + "\\" + result.name, 
						downloadSpeed: 0,
						usedRealDebrid: true,
						progress: 0,
						...result 
					}];
				});
				const torrent = await window.electronAPI.realdebrid.addTorrent(result.downloadURL);
				const isReady = window.electronAPI.realdebrid.isTorrentReady(torrent.id);
				if (!isReady) {
					window.electronAPI.realdebrid.selectTorrent(torrent.id);
					await new Promise<void>((resolve) => {
						const interval = setInterval(async () => {
							const isReady = await window.electronAPI.realdebrid.isTorrentReady(torrent.id);
							if (isReady) {
								clearInterval(interval);
								resolve();
							}
						}, 1000);
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

				const downloadID = await window.electronAPI.ddl.download([ { link: download.download, path: getDownloadPath() + "\\" + download.filename } ]);
				currentDownloads.update((downloads) => {
					const matchingDownload = downloads.find((d) => d.id === localID + '')!!
					matchingDownload.status = 'downloading';
					matchingDownload.id = downloadID;
					matchingDownload.usedRealDebrid = true;

					matchingDownload.downloadPath = getDownloadPath() + "\\" + download.filename;
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
				const downloadID = await window.electronAPI.torrent.downloadTorrent(result.downloadURL, getDownloadPath() + "\\" + (result.filename || result.downloadURL.split(/\\|\//).pop()));
				if (downloadID === null) {
					htmlButton.querySelector('[data-dwtext]')!!.textContent = "Download";
					htmlButton.disabled = false;
					return;
				}
				currentDownloads.update((downloads) => {
					return [...downloads, { 
						id: downloadID, 
						status: 'downloading', 
						downloadPath: getDownloadPath() + "\\" + result.filename, 
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

				const downloadID = await window.electronAPI.torrent.downloadMagnet(result.downloadURL!!, getDownloadPath() + "\\" + result.filename!!);
				if (downloadID === null) {
					htmlButton.querySelector('[data-dwtext]')!!.textContent = "Download";
					htmlButton.disabled = false;
					return;
				}
				currentDownloads.update((downloads) => {
					return [...downloads, { 
						id: downloadID, 
						status: 'downloading', 
						downloadPath: getDownloadPath() + "\\" + result.filename, 
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

				let collectedFiles = [ { path: getDownloadPath() + "\\" + result.filename!!, link: result.downloadURL!! } ];
				if (result.files) {
					collectedFiles = result.files.map((file) => {
						return { path: getDownloadPath() + "\\" + file.name, link: file.downloadURL };
					});
				}

				const downloadID = window.electronAPI.ddl.download(collectedFiles);
				if (downloadID === null) {
					htmlButton.querySelector('[data-dwtext]')!!.textContent = "Download";
					htmlButton.disabled = false;
					return;
				}
				currentDownloads.update((downloads) => {
					return [...downloads, { 
						id: downloadID, 
						status: 'downloading', 
						downloadPath: getDownloadPath() + "\\" + result.filename, 
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
</script>
<input id="search" on:change={search} placeholder="Search for Game" class="border border-gray-800 px-2 py-1 w-2/3 outline-none"/>
{#if loadingResults}
	{#if addons.length === 0}
		<div class="flex justify-center text-center flex-col items-center gap-2 w-4/6 border p-4 border-gray-800 bg-gray-200">
			<p class="text-2xl">Hey, you have no addons!</p>
			<p class="text-gray-400 text-sm w-full">Addons are the core of OpenGameInstaller, and you need them to download, search, and install your games! Get some online, okay?</p>
		</div>
	{:else}
		<div class="flex justify-center items-center w-1/6 border p-4 border-gray-800 bg-gray-200">
			<p>Loading...</p>
		</div>
	{/if}
{/if}
<div class="games">
	{#each results as result}
		<div class="relative rounded">
			<img src={result.coverURL} class="w-[187.5px] h-[250px]" alt="Game" />
			<article class="w-full">
					<h2>{result.name}</h2>
					<section class="h-5/6 mr-2 overflow-y-auto">
						<p>{result.description}</p>
					</section>
					<section class="flex flex-col w-full mt-auto">
						<nav class="flex flex-row items-center gap-4 mt-auto">
							<button class="download" on:click={(event) => startDownload(result, event)}>
								<section class="flex flex-row">
									<!-- {#if result.downloadType === 'magnet' || result.downloadType === 'real-debrid-torrent'}
										<img class="w-4 h-4" src="./rd-logo.png" alt="Real Debrid" />
									{/if} -->
									<h3 class="relative -top-1" data-dwtext>Download</h3>
								</section>

								<section class="w-full flex justify-center items-center">
									<img alt="" width="14" height="14" src="./apps.svg"/>
									<h3 class="text-white text-xs relative -top-[0.9px] -ml-[2px]">{result.addonSource}</h3>
								</section>
							</button>
							<nav class="flex flex-row justify-center items-center gap-2">
								{#if result.downloadType.includes('magnet')}
									<img class="w-4 h-4" src="./magnet-icon.gif" alt="Magnet" />
									<p>Magnet Link</p>
								{:else if result.downloadType.includes('torrent')}
									<img class="w-4 h-4" src="./torrent.png" alt="Torrent" />
									<p>Torrent File</p>
								{:else if result.downloadType === 'direct'}
									<p>Direct Download</p>
								{/if}
							</nav>
						</nav>
					</section>

			</article>
		</div>
	{/each}

	{#if results.length === 0 && !loadingResults}
		<div class="flex justify-center text-center flex-col items-center gap-2 w-full border p-4 border-gray-800 bg-gray-200">
			<p class="text-2xl">No Results</p>
		</div>
	{/if}
</div>

<style>
	.games {
		@apply flex flex-col gap-2 w-5/6 pb-4;
	}
	.games div {
		@apply border border-gray-800 bg-gray-200 p-2 flex flex-row gap-4;
	}
	.games section {
		@apply flex flex-row gap-2;
	}

	.download {
		@apply bg-blue-500 text-white p-2 rounded w-36 flex flex-col justify-center items-center;
	}
	.download:disabled {
		@apply bg-yellow-500 text-white p-2 rounded;
	}
	.games div article {
		@apply flex flex-col gap-2;
	}
	article h2 {
		@apply text-xl;
	}
	article p {
		@apply text-sm text-gray-500;
	}

</style>