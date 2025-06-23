<script lang="ts">
  // fetch the Steam store page
  import { onMount } from "svelte";
  import {
    fetchAddonsWithConfigure,
    safeFetch,
    startDownload,
    type GameData,
    type SearchResultWithAddon,
  } from "../utils";
  import {
    createNotification,
    currentStorePageOpened,
    currentStorePageOpenedStorefront,
    gameFocused,
    launchGameTrigger,
    selectedView,
    viewOpenedWhenChanged,
  } from "../store";
  import type { SearchResult } from "ogi-addon";
  interface Props {
    appID: number;
  }

  let { appID }: Props = $props();

  let results: SearchResultWithAddon[] = $state([]);
  let gameData: GameData | undefined = $state();
  let loading = $state(true);
  let queryingSources = $state(false);

  let alreadyOwns = window.electronAPI.fs.exists(
    "./library/" + appID + ".json"
  );
  onMount(async () => {
    isOnline = await window.electronAPI.app.isOnline();
    if (!isOnline) return;
    try {
      const response = await window.electronAPI.app.axios({
        method: "get",
        url: "https://store.steampowered.com/api/appdetails?appids=" + appID,
        headers: {
          "Accept-Language": "en-US,en;q=0.5",
        },
      });
      if (!response.data[appID].success) {
        console.error("Failed to fetch Steam store page");
        return;
      }
      gameData = response.data[appID].data;
      loading = false;
      // fetch addons and see if they have a download

      let addons = await fetchAddonsWithConfigure();

      queryingSources = true;
      let sourcesQueries = 0;
      if (alreadyOwns) {
        queryingSources = false;
        return;
      }
      if (addons.length === 0) {
        queryingSources = false;
        return;
      }
      for (const addon of addons) {
        safeFetch(
          "search",
          {
            addonID: addon.id,
            steamappid: String(appID),
          },
          { consume: "json" }
        ).then((data) => {
          sourcesQueries++;
          if (sourcesQueries === addons.length) {
            queryingSources = false;
          }
          results = [
            ...results,
            ...data.map((result: SearchResult) => {
              return {
                ...result,
                coverURL: `https://steamcdn-a.akamaihd.net/steam/apps/${appID}/library_600x900_2x.jpg`,
                name: result.name,
                addonSource: addon.id,
              };
            }),
          ];
        });
      }
    } catch (ex) {
      console.error(ex);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: "Failed to fetch Steam store page",
        type: "error",
      });
      currentStorePageOpened.set(undefined);
    }
  });

  function playGame() {
    if (!gameData) return;
    console.log("Playing game with ID: " + gameData.steam_appid);
    selectedView.set("library");
    viewOpenedWhenChanged.set("library");
    currentStorePageOpened.set(undefined);
    currentStorePageOpenedStorefront.set(undefined);
    gameFocused.set(gameData!.steam_appid);
    setTimeout(() => {
      launchGameTrigger.set(gameData!.steam_appid);
    }, 5);
  }

  let isOnline = $state(true);
</script>

{#if gameData}
  <main class="flex w-full h-full bg-white">
    {#if loading}
      <p class="py-2 px-4">Loading...</p>
    {:else}
      <div
        class="flex justify-start flex-col p-4 gap-2 w-full overflow-y-auto h-full"
      >
        <div class="flex flex-col object-cover relative gap-2">
          <div class="flex flex-col p-4 bg-slate-100 gap-2">
            <img
              src={gameData.header_image}
              alt={gameData.name}
              class="relative w-full rounded object-cover z-0"
            />
            <h1 class="text-3xl font-archivo font-medium">{gameData.name}</h1>
            <h2 class="text-sm">
              <p class="text-gray-500 inline">Developer:</p>
              {(gameData.developers ?? []).join(", ")}
              <span class="mx-2"></span>
              <p class="text-gray-500 inline">Publisher:</p>
              {(gameData.publishers ?? []).join(", ")}
              <span class="block"></span>
              <p class="text-gray-500 inline">Release Date:</p>
              {gameData.release_date.date}
            </h2>
            <p class="text-sm text-black">{gameData.short_description}</p>
          </div>
        </div>
        <article id="g-descript">{@html gameData.detailed_description}</article>
      </div>
      <div class="flex justify-start p-4 bg-slate-100 h-full w-3/6">
        {#if alreadyOwns}
          <div class="flex flex-col gap-2 w-full">
            <h2 class="text-2xl font-archivo font-medium">Installed</h2>
            <button
              class="px-4 py-2 bg-blue-300 rounded disabled:bg-yellow-300"
              onclick={() => playGame()}>Play</button
            >
          </div>
        {:else if results.length > 0}
          <div class="flex flex-col gap-2 w-full">
            <h2 class="text-2xl font-archivo font-medium">Sources</h2>
            {#each results as result}
              <div class="flex flex-col gap-2 bg-slate-200 rounded p-4 w-full">
                <p>{result.addonSource}</p>
                <button
                  class="px-4 py-2 bg-blue-300 rounded disabled:bg-yellow-300"
                  onclick={(event) => startDownload(result, appID, event)}
                  >Download</button
                >
                <nav
                  class="flex flex-row justify-center items-center gap-2 text-xs"
                >
                  {#if result.downloadType === "magnet"}
                    <img class="w-4 h-4" src="./magnet-icon.gif" alt="Magnet" />
                    <p>Magnet Link</p>
                  {:else if result.downloadType === "torrent"}
                    <img class="w-4 h-4" src="./torrent.png" alt="Torrent" />
                    <p>Torrent File</p>
                  {:else if result.downloadType === "direct"}
                    <p>Direct Download</p>
                  {/if}
                </nav>
              </div>
            {/each}
          </div>
        {/if}

        {#if results.length === 0 && !queryingSources && !alreadyOwns}
          <div class="flex flex-col gap-2 w-full">
            <h2 class="text-2xl font-archivo font-medium">Sources</h2>
            <p class="font-open-sans">No Results</p>
          </div>
        {/if}
      </div>
    {/if}
  </main>
{:else if !isOnline}
  <div class="flex flex-col gap-2 w-full justify-center items-center h-full">
    <img src="./favicon.png" alt="content" class="w-32 h-32" />
    <h1 class="text-2xl text-black">You're Offline</h1>
    <h1 class="text-lg text-gray-500 text-center">
      Loading Game Stores is unsupported when you're offline.
    </h1>
  </div>
{:else}
  <div class="flex justify-center items-center w-full h-full">
    <p class="text-2xl">Loading...</p>
  </div>
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
