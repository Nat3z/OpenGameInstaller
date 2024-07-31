<script lang="ts">
  import { onMount } from "svelte";
  import { fetchAddonsWithConfigure, safeFetch, startDownload, type SearchResultWithAddon } from "../utils";
  import type { OGIAddonConfiguration, SearchResult } from "ogi-addon";
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

	
</script>
<input id="search" on:change={search} type="text" placeholder="Search for Game" class="p-2 pl-2 bg-slate-100 rounded-lg w-2/3"/>
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
			<img src={result.coverURL} class="w-[187.5px] h-[250px] rounded" alt="Game" />
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
									<h3 class="relative -top-1 font-archivo font-semibold" data-dwtext>Download</h3>
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