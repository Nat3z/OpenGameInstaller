<script lang="ts">
  import { onMount } from "svelte";
  import { fetchAddonsWithConfigure, safeFetch, type GameData } from "../utils";
	import { currentStorePageOpened, viewOpenedWhenChanged } from '../store'
  import type { OGIAddonConfiguration } from "ogi-addon";
  import type { ConfigurationFile } from "ogi-addon/config";
	interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
    configTemplate: ConfigurationFile
  }
	let addons: ConfigTemplateAndInfo[] = [];
  onMount(() => {
    safeFetch("http://localhost:7654/addons").then((data) => {
      addons = data;
    });
  });
	function extractSimpleName(input: string) {
		// Regular expression to match the game name
		const regex = /^(.+?)([:\-–])/;
		const match = input.match(regex);
		return match ? match[1].trim() : null;
	}

	async function getRealGame(titleId: string): Promise<string | undefined> {
		const response = await window.electronAPI.app.axios({
			method: "GET",
			url: `https://store.steampowered.com/api/appdetails?appids=${titleId}`
		});
		if (!response.data[titleId].success) {
			return undefined;
		}
		if (response.data[titleId].data.type === 'game') {
			return titleId;
		}

		if (response.data[titleId].data.type === 'dlc' || response.data[titleId].data.type === 'dlc_sub' || response.data[titleId].data.type === 'music' || response.data[titleId].data.type === 'video' || response.data[titleId].data.type === 'episode') { 
			return response.data[titleId].data.fullgame.appid;
		}
		if (response.data[titleId].data.type === 'demo') {
			return response.data[titleId].data.fullgame.appid;
		}

		return undefined;
	}
	async function matchSteamAppID(title: string): Promise<{ appid: string, name: string }[] | undefined> {
		const steamAppId = await window.electronAPI.app.searchFor(title); 
		if (steamAppId.length === 0) {
			return undefined;
		}
		return steamAppId;
	}

	let results: GameData[] = [];

	let loadingResults = false;
	async function search() {
		// fetch addons first
		loadingResults = true;
		addons = await fetchAddonsWithConfigure();
		results = [];
		const search = document.getElementById("search")!! as HTMLInputElement;
		const query = search.value;
		if (!query) {
			loadingResults = false;
			return;
		}
		// first get the steam app id
		const possibleSteamApps = await matchSteamAppID(extractSimpleName(query) ?? query);
		if (!possibleSteamApps) {
			loadingResults = false;
			return;
		}
		let amountSearched = 0;
		for (const possibleSteamApp of possibleSteamApps) {
			amountSearched++;
			const real = await getRealGame(possibleSteamApp.appid);
			console.log(real);
			if (!real) {
				continue;
			}
			const response = await window.electronAPI.app.axios({
				method: "GET",
				url: `https://store.steampowered.com/api/appdetails?appids=${real}`
			});
			if (!response.data[real].success) {
				console.error("Failed to fetch Steam store page");
				return;
			}
			const gameData: GameData = response.data[real].data;
			// check if the appid is already in the results
			if (results.find((result) => result.steam_appid === gameData.steam_appid)) {
				continue;
			}
			results = [...results, gameData];
			if (amountSearched >= 10) {
				break;
			}
		}
		loadingResults = false;
	}

	function goToListing(steam_appid: number) {
		currentStorePageOpened.set(steam_appid)
		viewOpenedWhenChanged.set('gameInstall');
	}	
</script>
<input id="search" on:change={search} type="text" placeholder="Search for Game" class="p-2 pl-2 bg-slate-100 rounded-lg w-2/3 mt-4"/>
{#if loadingResults}
	{#if addons.length === 0}
		<div class="flex justify-center text-center flex-col items-center gap-2 w-4/6 bg-slate-100 rounded p-4">
			<p class="text-2xl">Hey, you have no addons!</p>
			<p class="text-gray-400 text-sm w-full">Addons are the core of OpenGameInstaller, and you need them to download, search, and setup your games! Get some online, okay?</p>
		</div>
	{:else}
		<div class="flex justify-center items-center w-1/6 border p-4 bg-slate-100 rounded">
			<p class="text-lg">Loading...</p>
		</div>
	{/if}
{/if}
<div class="games">
	{#each results as result}
		<div class="relative rounded">
			<img src={result.header_image} alt={result.name} class="rounded w-1/4 h-full object-cover"/>
			<span class="h-full flex flex-col justify-start items-start">
				<h1 class="font-archivo">{result.name}</h1>
				<button class="mt-auto py-2 px-4 hover:underline rounded" on:click={() => goToListing(result.steam_appid)}>Go to Listing</button>
			</span>
		</div>
	{/each}

	{#if results.length === 0 && !loadingResults}
		<div class="flex justify-center text-center flex-col items-center gap-2 w-full border bg-slate-100 rounded">
			<p class="text-2xl">No Results</p>
		</div>
	{/if}
</div>

<style>
	.games {
		@apply flex flex-col gap-2 w-5/6 pb-4;
	}
	.games div {
		@apply border bg-slate-100 border-gray-200 p-2 flex flex-row gap-4;
	}
	.games section {
		@apply flex flex-row gap-2;
	}

	.download {
		@apply bg-accent text-white p-2 rounded w-36 flex flex-col justify-center items-center;
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