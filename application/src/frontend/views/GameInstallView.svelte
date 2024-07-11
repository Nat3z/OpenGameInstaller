<script lang="ts">
  import { onMount } from "svelte";
  import { fetchAddonsWithConfigure, safeFetch } from "../utils";
  import type { OGIAddonConfiguration, SearchResult } from "ogi-addon";
  import type { ConfigurationFile } from "ogi-addon/build/config/ConfigurationBuilder";
  import { currentDownloads } from "../store";
	interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
    configTemplate: ConfigurationFile
  }
	let addons: ConfigTemplateAndInfo[] = [];
  onMount(() => {
    safeFetch("http://localhost:7654/addons").then((data) => {
      addons = data;
    });
  });

	interface SearchResultWithAddon extends SearchResult {
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
		const htmlButton = (event.target as HTMLButtonElement);
		htmlButton.textContent = "Downloading...";
		htmlButton.disabled = true;

		switch (result.downloadType) {
			case 'real-debrid-magnet': {
				const worked = window.electronAPI.realdebrid.updateKey();
				if (!worked) {
					alert("Please set your Real-Debrid API key in the settings.");
					return;
				}
				// get the first host
				// const hosts = window.electronAPI.realdebrid.getHosts();	
				// // add magnet link
				// const magnetLink = window.electronAPI.realdebrid.addMagnet(result.downloadURL, hosts[0]);
				// const download = await window.electronAPI.realdebrid.unrestrictLink(magnetLink.uri);

				//! for testing purposes, we will use a direct link
				const download = await window.electronAPI.realdebrid.unrestrictLink(result.downloadURL);
				if (download === null) {
					alert("Failed to download the file.");
					return;
				}
				const downloadID = await window.electronAPI.ddl.download(download.download, "C:\\Users\\apbro\\Documents\\TestFolder\\" + download.filename);
				currentDownloads.update((downloads) => {
					return [...downloads, { 
						id: downloadID, 
						status: 'downloading', 
						downloadPath: 'C:\\Users\\apbro\\Documents\\TestFolder', 
						downloadSpeed: 0,
						progress: 0,
						...result 
					}];
				});
				break;
			}
			case "real-debrid-torrent": {
				const worked = window.electronAPI.realdebrid.updateKey();
				if (!worked) {
					alert("Please set your Real-Debrid API key in the settings.");
					return;
				}
				// add torrent link
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
					alert("Failed to download the file.");
					return;
				}
				const downloadID = await window.electronAPI.ddl.download(download.download, "C:\\Users\\apbro\\Documents\\TestFolder\\" + download.filename);
				currentDownloads.update((downloads) => {
					return [...downloads, { 
						id: downloadID, 
						status: 'downloading', 
						downloadPath: 'C:\\Users\\apbro\\Documents\\TestFolder', 
						downloadSpeed: 0,
						progress: 0,
						...result 
					}];
				});
				break;
			}
			case 'torrent':
			case "direct":
				alert("Currently not supported.")
				break;
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
		<div>
			<img src={result.coverURL} class="w-[187.5px] h-[250px]" alt="Game" />
			<article>
					<h2>{result.name}</h2>
					<p>{result.description}</p>
					<section>
						<button class="download" on:click={(event) => startDownload(result, event)}>Download</button>
					</section>
			</article>
		</div>
	{/each}
</div>

<style>
	.games {
		@apply flex flex-col gap-2 bg-gray-200 w-5/6;
	}
	.games div {
		@apply border border-gray-800 p-2 flex flex-row gap-2;
	}
	.games section {
		@apply flex flex-row gap-2;
	}

	section .download {
		@apply bg-blue-500 text-white p-2 rounded;
	}
	section .download:disabled {
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