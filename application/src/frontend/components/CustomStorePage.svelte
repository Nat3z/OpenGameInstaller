<script lang="ts">
  import { onMount } from 'svelte';
  import { safeFetch, startDownload, type SearchResultWithAddon } from '../utils';
  import { createNotification, currentStorePageOpened, currentStorePageOpenedSource, currentStorePageOpenedStorefront, gameFocused, launchGameTrigger, selectedView, viewOpenedWhenChanged } from '../store';
  import type { SearchResult, StoreData } from 'ogi-addon';
  export let appID: number;
  export let addonSource: string;
	let results: SearchResultWithAddon[] = [];
  let gameData: StoreData;
  let loading = true;
  let queryingSources = false;

	let alreadyOwns = window.electronAPI.fs.exists('./library/' + appID + '.json');
  onMount(async () => {
    try {
      const response: StoreData = await safeFetch("http://localhost:7654/addons/" + addonSource + '/game-details?gameID=' + appID, { consume: 'json' }); 
      loading = false;
      gameData = response;
      safeFetch("http://localhost:7654/addons/" + addonSource + "/search?gameID=" + appID, { consume: 'json' }).then((data: SearchResult[]) => {
        results = [ ...results, 
          ...data.map((result: SearchResult) => {
            return {
              ...result,
              coverURL: result.coverURL,
              name: gameData.name,
              addonSource,
            }
          })
        ];
      });
    } catch (ex) {
      console.error(ex);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Failed to fetch Custom store page',
        type: 'error'
      });
      currentStorePageOpened.set(undefined);
      currentStorePageOpenedSource.set(undefined);
      currentStorePageOpenedStorefront.set(undefined);
    }

  });

  function playGame() {
    console.log("Playing game with ID: " + gameData.appID);
    selectedView.set('library');
    viewOpenedWhenChanged.set('library');
    currentStorePageOpened.set(undefined);
		currentStorePageOpenedStorefront.set(undefined);
    console.log(typeof gameData.appID);
		gameFocused.set(gameData.appID);
		setTimeout(() => {
			launchGameTrigger.set(gameData.appID);
		}, 5);	
  }
</script>
{#if gameData}
<main class="flex w-full h-full bg-white">
  {#if loading}
    <p class="py-2 px-4">Loading...</p>
  {:else}
    <div class="flex justify-start flex-col p-4 gap-2 w-full overflow-y-auto h-full">
      <div class="flex flex-col object-cover relative gap-2">
        <div class="flex flex-col p-4 bg-slate-100 gap-2">
        <img src={gameData.headerImage} alt={gameData.name} class="relative w-full rounded object-cover z-0" />
          <h1 class="text-3xl font-archivo font-medium">{gameData.name}</h1>
          <h2 class="text-sm">
            <p class="text-gray-500 inline">Developer:</p> {(gameData.developers ?? []).join(', ')}
            <span class="mx-2"></span>
            <p class="text-gray-500 inline">Publisher:</p> {(gameData.publishers ?? []).join(', ')}
            <span class="block"></span>
            <p class="text-gray-500 inline">Release Date:</p> {gameData.releaseDate}
          </h2>
          <p class="text-sm text-black">{gameData.basicDescription}</p>
        </div>
      </div>
      <article id="g-descript">{@html gameData.description}</article>

    </div>
    <div class="flex justify-start p-4 bg-slate-100 h-full w-3/6">
      {#if alreadyOwns}
        <div class="flex flex-col gap-2 w-full">
          <h2 class="text-2xl font-archivo font-medium">Installed</h2>
          <button class="px-4 py-2 bg-blue-300 rounded disabled:bg-yellow-300" on:click={() => playGame()}>Play</button>
        </div>
      {:else}
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
      {/if}

      {#if results.length === 0 && !queryingSources && !alreadyOwns}
        <div class="flex flex-col gap-2 w-full">
          <h2 class="text-2xl font-archivo font-medium">Sources</h2>
          <p class="font-open-sans">
            No Results
          </p>
        </div>
      {/if}
    </div>
  {/if}
</main>
{/if}
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
