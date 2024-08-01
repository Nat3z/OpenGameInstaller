<script lang="ts">
  // fetch the Steam store page
  import { onMount } from 'svelte';
  import { fetchAddonsWithConfigure, safeFetch, startDownload, type GameData, type SearchResultWithAddon } from '../utils';
  import type { SearchResult } from 'ogi-addon';
  export let appID: number;

	let results: SearchResultWithAddon[] = [];
  let gameData: GameData;
  let loading = true;
  let queryingSources = false;
  onMount(async () => {
    const response = await window.electronAPI.app.axios({
      method: 'get',
      url: 'https://store.steampowered.com/api/appdetails?appids=' + appID,
      headers: {
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });
    if (!response.data[appID].success) {
      console.error('Failed to fetch Steam store page');
      return;
    }
    gameData = response.data[appID].data;
    loading = false;
    // fetch addons and see if they have a download

		let addons = await fetchAddonsWithConfigure();

    queryingSources = true;
    let sourcesQueries = 0;
    for (const addon of addons) {
			safeFetch("http://localhost:7654/addons/" + addon.id + "/search?steamappid=" + appID, { consume: 'json' }).then((data) => {
        sourcesQueries++;
        if (sourcesQueries === addons.length) {
          queryingSources = false;
        }
				results = [ ...results, 
					...data.map((result: SearchResult) => {
						return {
							...result,
              coverURL: `https://steamcdn-a.akamaihd.net/steam/apps/${appID}/library_600x900_2x.jpg`,
              name: gameData.name,
							addonSource: addon.id
						}
					})
				 ];
			});
		}
  });
</script>

<main class="flex w-full h-full bg-white">
  {#if loading}
    <p class="py-2 px-4">Loading...</p>
  {:else}
    <div class="flex justify-start flex-col p-4 gap-2 w-full overflow-y-auto h-full">
      <div class="flex flex-col object-cover relative gap-2">
        <div class="flex flex-col p-4 bg-slate-100 gap-2">
        <img src={gameData.header_image} alt={gameData.name} class="relative w-full rounded object-cover z-0" />
          <h1 class="text-3xl font-archivo font-medium">{gameData.name}</h1>
          <h2 class="text-sm">
            <p class="text-gray-500 inline">Developer:</p> {gameData.developers.join(', ')}
            <span class="mx-2"></span>
            <p class="text-gray-500 inline">Publisher:</p> {gameData.publishers.join(', ')}
            <span class="block"></span>
            <p class="text-gray-500 inline">Release Date:</p> {gameData.release_date.date}
          </h2>
          <p class="text-sm text-black">{gameData.short_description}</p>
        </div>
      </div>
      <article id="g-descript">{@html gameData.detailed_description}</article>

    </div>
    <div class="flex justify-start p-4 bg-slate-100 h-full w-3/6">
      {#if results.length > 0}
        <div class="flex flex-col gap-2 w-full">
          <h2 class="text-2xl font-archivo font-medium">Sources</h2>
          {#each results as result}
            <div class="flex flex-col gap-2 bg-slate-200 rounded p-4 w-full">
              <p>{result.addonSource}</p>
              <button class="px-4 py-2 bg-blue-300 rounded disabled:bg-yellow-300" on:click={(event) => startDownload(result, event)}>Download</button>
              <nav class="flex flex-row justify-center items-center gap-2 text-xs">
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
            </div>
          {/each}
        </div>
      {/if}

      {#if results.length === 0 && !queryingSources}
        <div class="flex justify-center text-center flex-col items-center gap-2 w-full bg-slate-100 rounded">
          <p class="text-2xl">
            No Results
          </p>
        </div>
      {/if}
    </div>
  {/if}
</main>

<style global>
  #g-descript {
    @apply p-4 bg-slate-100 rounded flex flex-col gap-2; 
  }

  #g-descript img {
    @apply w-full rounded;
  }
  #g-descript p {
    @apply text-sm text-black;
  }
  #g-descript h1 {
    @apply text-2xl font-archivo font-medium;
  }
  #g-descript h2 {
    @apply text-sm;
  }
  #g-descript strong {
    @apply font-bold text-gray-900;
  }
</style>
