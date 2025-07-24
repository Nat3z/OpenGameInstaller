<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchAddonsWithConfigure,
    safeFetch,
    startDownload,
    type GameData,
    type SearchResultWithAddon,
  } from '../utils';
  import {
    createNotification,
    currentStorePageOpened,
    currentStorePageOpenedSource,
    currentStorePageOpenedStorefront,
    gameFocused,
    launchGameTrigger,
    selectedView,
    viewOpenedWhenChanged,
  } from '../store';
  import type { SearchResult, StoreData } from 'ogi-addon';
  import AddonPicture from './AddonPicture.svelte';
  import Modal from './modal/Modal.svelte';
  import TitleModal from './modal/TitleModal.svelte';
  import HeaderModal from './modal/HeaderModal.svelte';
  import SectionModal from './modal/SectionModal.svelte';
  import TextModal from './modal/TextModal.svelte';

  interface Props {
    appID: number;
    storefront: string;
    addonSource?: string;
  }

  let { appID, storefront, addonSource }: Props = $props();

  let results: SearchResultWithAddon[] = $state([]);
  let gameData: (GameData & { hero_image: string }) | StoreData | undefined =
    $state();
  let loading = $state(true);
  let queryingSources = $state(false);
  let selectedResult: SearchResultWithAddon | undefined = $state();
  let isOnline = $state(true);

  let alreadyOwns = window.electronAPI.fs.exists(
    './library/' + appID + '.json'
  );

  let normalizedGameData:
    | {
        hero_image: string;
        name: string;
        publishers: string[];
        developers: string[];
        release_date: string;
        detailed_description: string;
      }
    | undefined = $state();

  $effect(() => {
    if (!gameData) {
      normalizedGameData = undefined;
      return;
    }

    if (isSteamStore) {
      const steamData = gameData as GameData & { hero_image: string };
      normalizedGameData = {
        hero_image: steamData.hero_image,
        name: steamData.name,
        publishers: steamData.publishers,
        developers: steamData.developers,
        release_date: steamData.release_date.date,
        detailed_description: steamData.detailed_description,
      };
    } else {
      const customData = gameData as StoreData;
      normalizedGameData = {
        hero_image: customData.headerImage,
        name: customData.name,
        publishers: customData.publishers,
        developers: customData.developers,
        release_date: customData.releaseDate,
        detailed_description: customData.description,
      };
    }
  });

  // Check if this is a Steam store page
  const isSteamStore = storefront === 'steam';

  onMount(async () => {
    isOnline = await window.electronAPI.app.isOnline();
    if (!isOnline && isSteamStore) {
      loading = false;
      return;
    }

    try {
      if (isSteamStore) {
        await loadSteamStoreData();
      } else {
        await loadCustomStoreData();
      }
    } catch (ex) {
      console.error(ex);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: `Failed to fetch ${isSteamStore ? 'Steam' : 'Custom'} store page`,
        type: 'error',
      });
      currentStorePageOpened.set(undefined);
      if (!isSteamStore) {
        currentStorePageOpenedSource.set(undefined);
      }
      currentStorePageOpenedStorefront.set(undefined);
    }
  });

  async function loadSteamStoreData() {
    // Add Steam as default source

    const response = await window.electronAPI.app.axios({
      method: 'get',
      url: 'https://store.steampowered.com/api/appdetails?appids=' + appID,
      headers: {
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    if (!response.data[appID].success) {
      throw new Error('Failed to fetch Steam store page');
    }

    const responseData: GameData = response.data[appID].data;
    gameData = {
      ...responseData,
      hero_image: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appID}/library_hero.jpg`,
    };
    loading = false;

    // Fetch addon sources for Steam games
    if (!alreadyOwns) {
      let addons = await fetchAddonsWithConfigure();
      queryingSources = true;
      let sourcesQueries = 0;

      if (addons.length === 0) {
        queryingSources = false;
        return;
      }

      for (const addon of addons) {
        safeFetch(
          'search',
          {
            addonID: addon.id,
            steamappid: String(appID),
          },
          { consume: 'json' }
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
                coverImage: `https://steamcdn-a.akamaihd.net/steam/apps/${appID}/library_hero.jpg`,
                capsuleImage: `https://steamcdn-a.akamaihd.net/steam/apps/${appID}/library_600x900_2x.jpg`,
                name: result.name,
                addonSource: addon.id,
              };
            }),
          ];
        });
      }
    }
  }

  async function loadCustomStoreData() {
    if (!addonSource) {
      throw new Error('Addon source is required for custom store pages');
    }

    const response: StoreData = await safeFetch(
      'gameDetails',
      {
        addonID: addonSource,
        gameID: String(appID),
      },
      { consume: 'json' }
    );

    gameData = response;
    loading = false;

    // Fetch search results for custom store
    if (alreadyOwns) return;

    let addons = await fetchAddonsWithConfigure();
    queryingSources = true;

    if (addons.length === 0) {
      queryingSources = false;
      return;
    }

    for (const addon of addons) {
      let searchResults = await safeFetch(
        'search',
        {
          addonID: addon.id,
          gameID: String(appID),
        },
        { consume: 'json' }
      );
      results = [
        ...results,
        ...searchResults.map((result: SearchResult) => {
          return {
            ...result,
            coverImage: (gameData as StoreData).coverImage,
            capsuleImage: (gameData as StoreData).capsuleImage,
            name: (gameData as StoreData).name!,
            addonSource: addon.id,
          };
        }),
      ];
    }
    queryingSources = false;
  }

  function playGame() {
    if (!gameData) return;

    const gameID = isSteamStore
      ? (gameData as GameData & { hero_image: string }).steam_appid
      : (gameData as StoreData).appID;

    console.log('Playing game with ID: ' + gameID);
    selectedView.set('library');
    viewOpenedWhenChanged.set('library');
    currentStorePageOpened.set(undefined);
    currentStorePageOpenedStorefront.set(undefined);
    if (!isSteamStore) {
      currentStorePageOpenedSource.set(undefined);
    }
    gameFocused.set(gameID);
    setTimeout(() => {
      launchGameTrigger.set(gameID);
    }, 5);
  }

  function showSourceInfo(result: SearchResultWithAddon) {
    console.log('Showing source info for: ' + result.addonSource);
    selectedResult = result;
  }

  function closeInfoModal() {
    selectedResult = undefined;
  }

  // Debug reactive statement
  $effect(() => {
    console.log('Modal state changed - selectedResult:', selectedResult);
  });
</script>

{#if gameData}
  <main class="flex flex-col w-full h-full">
    {#if loading}
      <p class="py-2 px-4">Loading...</p>
    {:else if normalizedGameData}
      <!-- Unified Store Layout -->
      <!-- Hero Banner Section -->
      <div class="">
        <div class="relative w-full h-64 overflow-hidden rounded-lg">
          <img
            src={normalizedGameData.hero_image}
            alt={normalizedGameData.name}
            class="w-full h-full object-cover rounded-lg"
          />
          <!-- Overlay with game info -->
          <div
            class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-6 rounded-b-lg"
          >
            <h1 class="text-4xl font-archivo font-bold text-white mb-2">
              {normalizedGameData.name}
            </h1>
            <div class="text-sm text-gray-200">
              <span class="text-gray-300">Publisher:</span>
              {(normalizedGameData.publishers ?? []).join(', ')}
              <span class="mx-4"></span>
              <span class="text-gray-300">Developer:</span>
              {(normalizedGameData.developers ?? []).join(', ')}
              <br />
              <span class="text-gray-300">Release Date:</span>
              {normalizedGameData.release_date}
            </div>
          </div>
        </div>
      </div>

      <!-- Main Content Area -->
      <div class="flex flex-1 overflow-hidden gap-4">
        <!-- Left side - Description -->
        <div class="mt-4 flex-1 overflow-y-auto relative">
          <!-- Fade gradient overlay at top -->
          <div
            class="sticky top-0 h-4 bg-gradient-to-b from-white/80 to-transparent z-10 pointer-events-none"
          ></div>

          <!-- Detailed description -->
          <div class="pb-10 -mt-4">
            <article
              id="g-descript"
              class="prose max-w-none text-accent-dark pt-4"
            >
              {@html normalizedGameData.detailed_description}
            </article>
          </div>
        </div>

        <!-- Right sidebar -->
        <div class="w-80 flex flex-col pt-4">
          <!-- Sources Section -->
          {#if alreadyOwns}
            <div class="p-6 bg-accent-lighter rounded-lg">
              <button
                class="w-full bg-green-500 hover:bg-green-600 text-white font-medium py-3 px-4 rounded-lg transition-colors duration-200"
                onclick={() => playGame()}
              >
                Play Game
              </button>
            </div>
          {:else}
            <div class="flex-1 overflow-y-auto">
              {#if results.length > 0}
                {#each results as result}
                  <div class="bg-accent-lighter rounded-lg p-4 mb-4">
                    <div class="flex items-center justify-between mb-2">
                      <div class="flex flex-row gap-2 items-center">
                        <AddonPicture
                          addonId={result.addonSource}
                          class="w-12 h-12 rounded-lg"
                        />
                        <span class="font-medium text-gray-800"
                          >{result.addonSource}</span
                        >
                      </div>
                      <div
                        class="flex items-center gap-1 text-xs text-gray-500"
                      >
                        {#if result.downloadType === 'magnet'}
                          <img
                            class="w-4 h-4"
                            src="./magnet-icon.gif"
                            alt="Magnet"
                          />
                          <span>Magnet</span>
                        {:else if result.downloadType === 'torrent'}
                          <img
                            class="w-4 h-4"
                            src="./torrent.png"
                            alt="Torrent"
                          />
                          <span>Torrent</span>
                        {:else if result.downloadType === 'direct'}
                          <span>Direct</span>
                        {:else if result.downloadType === 'request'}
                          <span>Request</span>
                        {/if}
                      </div>
                    </div>
                    <div class="flex flex-row gap-2">
                      <button
                        class="w-full text-lg border-none bg-accent-light hover:bg-opacity-80 text-accent-dark font-medium py-3 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors duration-200"
                        disabled={results.length === 0 && !queryingSources}
                        onclick={(event) => startDownload(result, appID, event)}
                      >
                        Download
                      </button>
                      <button
                        class="text-lg border-none w-16 bg-accent-light hover:bg-opacity-80 text-accent-dark font-medium py-3 rounded-lg flex items-center justify-center gap-2 transition-colors duration-200"
                        aria-label="Source Information"
                        onclick={() => showSourceInfo(result)}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          class="fill-accent-dark w-6 h-6"
                        >
                          <g clip-path="url(#clip0_22_330)">
                            <path
                              d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 17C11.45 17 11 16.55 11 16V12C11 11.45 11.45 11 12 11C12.55 11 13 11.45 13 12V16C13 16.55 12.55 17 12 17ZM13 9H11V7H13V9Z"
                              fill="#2D626A"
                            />
                          </g>
                          <defs>
                            <clipPath id="clip0_22_330">
                              <rect
                                width="24"
                                height="24"
                                rx="12"
                                fill="white"
                              />
                            </clipPath>
                          </defs>
                        </svg>
                      </button>
                    </div>
                  </div>
                {/each}
              {:else if queryingSources}
                <div class="text-center py-8">
                  <div
                    class="animate-spin w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full mx-auto mb-3"
                  ></div>
                  <p class="text-gray-600">Searching sources...</p>
                </div>
              {:else}
                <div class="text-center py-8">
                  <p class="text-gray-600">No sources available</p>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </main>
{:else if !isOnline && isSteamStore}
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

<!-- Source Information Modal (for Steam store only) -->
{#key selectedResult}
  {#if selectedResult}
    <Modal
      open={selectedResult !== undefined}
      size="medium"
      onClose={closeInfoModal}
    >
      <TitleModal title="Source Information" />
      <HeaderModal header={selectedResult.addonSource} />

      <SectionModal>
        <div class="flex flex-col gap-4">
          <div class="flex items-center gap-3">
            <AddonPicture
              addonId={selectedResult.addonSource}
              class="w-16 h-16 rounded-lg"
            />
            <div>
              <h3 class="text-lg font-semibold">
                {selectedResult.addonSource}
              </h3>
              <TextModal text="Addon Source" variant="description" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <TextModal text="Download Type" variant="caption" />
              <div class="flex items-center gap-2">
                {#if selectedResult.downloadType === 'magnet'}
                  <img class="w-5 h-5" src="./magnet-icon.gif" alt="Magnet" />
                  <span class="text-sm font-medium">Magnet Link</span>
                {:else if selectedResult.downloadType === 'torrent'}
                  <img class="w-5 h-5" src="./torrent.png" alt="Torrent" />
                  <span class="text-sm font-medium">Torrent File</span>
                {:else if selectedResult.downloadType === 'direct'}
                  <span class="text-sm font-medium">Direct Download</span>
                {:else if selectedResult.downloadType === 'request'}
                  <span class="text-sm font-medium">Request</span>
                {/if}
              </div>
            </div>

            <div>
              <TextModal text="Download Name" variant="caption" />
              <TextModal text={selectedResult.name} variant="body" />
            </div>
          </div>

          {#if selectedResult.storefront}
            <div>
              <TextModal text="Storefront" variant="caption" />
              <TextModal text={selectedResult.storefront} variant="body" />
            </div>
          {/if}

          {#if selectedResult.manifest}
            <div>
              <TextModal text="Manifest" variant="caption" />
              <TextModal
                text={JSON.stringify(selectedResult.manifest, null, 2)}
                variant="body"
              />
            </div>
          {/if}
        </div>
      </SectionModal>
    </Modal>
  {/if}
{/key}

<style global>
  #g-descript {
    @apply text-gray-700 bg-transparent;
  }

  #g-descript img {
    @apply w-full rounded-lg my-4;
  }

  #g-descript p {
    @apply text-sm text-gray-700 mb-3 leading-relaxed;
  }

  #g-descript h1 {
    @apply text-xl font-archivo font-semibold text-gray-800 mb-3;
  }

  #g-descript h2 {
    @apply text-lg font-archivo font-medium text-gray-800 mb-2;
  }

  #g-descript strong {
    @apply font-semibold text-gray-900;
  }

  #g-descript ul,
  #g-descript ol {
    @apply mb-3 ml-4;
  }

  #g-descript li {
    @apply text-sm text-gray-700 mb-1;
  }

  #g-descript-custom {
    @apply text-gray-700 bg-transparent;
  }

  #g-descript-custom img {
    @apply w-full rounded-lg my-4;
  }

  #g-descript-custom p {
    @apply text-sm text-gray-700 mb-3 leading-relaxed;
  }

  #g-descript-custom h1 {
    @apply text-xl font-archivo font-semibold text-gray-800 mb-3;
  }

  #g-descript-custom h2 {
    @apply text-lg font-archivo font-medium text-gray-800 mb-2;
  }

  #g-descript-custom strong {
    @apply font-semibold text-gray-900;
  }

  #g-descript-custom ul,
  #g-descript-custom ol {
    @apply mb-3 ml-4;
  }

  #g-descript-custom li {
    @apply text-sm text-gray-700 mb-1;
  }
</style>
