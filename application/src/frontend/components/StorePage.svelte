<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchAddonsWithConfigure,
    runTask,
    safeFetch,
    startDownload,
    type SearchResultWithAddon,
  } from '../utils';
  import {
    createNotification,
    currentStorePageOpened,
    currentStorePageOpenedStorefront,
    gameFocused,
    launchGameTrigger,
    selectedView,
    viewOpenedWhenChanged,
    currentDownloads,
  } from '../store';
  import type { SearchResult, StoreData } from 'ogi-addon';
  import AddonPicture from './AddonPicture.svelte';
  import Modal from './modal/Modal.svelte';
  import TitleModal from './modal/TitleModal.svelte';
  import HeaderModal from './modal/HeaderModal.svelte';
  import SectionModal from './modal/SectionModal.svelte';
  import TextModal from './modal/TextModal.svelte';
  import { fade, fly, slide } from 'svelte/transition';

  interface Props {
    appID: number;
    storefront: string;
  }

  let { appID, storefront }: Props = $props();

  let results: SearchResultWithAddon[] = $state([]);
  let gameData: StoreData | undefined = $state();
  let loading = $state(true);
  let queryingSources = $state(false);
  let selectedResult: SearchResultWithAddon | undefined = $state();
  let isOnline = $state(true);
  let loadingAddons: Set<string> = $state(new Set());
  let emptyAddons: Set<string> = $state(new Set());
  let collapsedAddons: Set<string> = $state(new Set());
  let originalFilePath: string | undefined = $derived.by(() => {
    try {
      if (alreadyOwns) {
        const libraryEntryUnSerialized = window.electronAPI.fs.read(
          './library/' + appID + '.json'
        );
        if (libraryEntryUnSerialized) {
          const libraryEntry = JSON.parse(libraryEntryUnSerialized);
          return libraryEntry.cwd;
        }
      }
      return undefined;
    } catch (ex) {
      console.error(ex);
      return undefined;
    }
  });

  let originalExecutable: string | undefined = $derived.by(() => {
    try {
      if (alreadyOwns) {
        const libraryEntryUnSerialized = window.electronAPI.fs.read(
          './library/' + appID + '.json'
        );
        if (libraryEntryUnSerialized) {
          const libraryEntry = JSON.parse(libraryEntryUnSerialized);
          return libraryEntry.launchExecutable;
        }
      }
      return undefined;
    } catch (ex) {
      console.error(ex);
      return undefined;
    }
  });

  let alreadyOwns = $state(false);

  let platform = $state('');
  let isWin32Only: boolean = $derived.by(() => {
    return (
      platform !== 'win32' &&
      alreadyOwns &&
      typeof originalExecutable === 'string' &&
      originalExecutable.toLowerCase().endsWith('.exe')
    );
  });

  // Check for active downloads for this game
  let activeDownload = $derived(
    $currentDownloads.find(
      (download) => download.appID === appID && download.status !== 'error'
    )
  );

  // Helper function to format download speed
  function formatSpeed(speed: number): string {
    if (speed < 1024) {
      return speed.toFixed(0) + ' B/s';
    } else if (speed < 1024 * 1024) {
      return (speed / 1024).toFixed(2) + ' KB/s';
    } else {
      return (speed / (1024 * 1024)).toFixed(2) + ' MB/s';
    }
  }

  // Helper function to format file size
  function formatSize(size: number): string {
    if (size < 1024) {
      return size + ' B';
    } else if (size < 1024 * 1024) {
      return (size / 1024).toFixed(2) + ' KB';
    } else if (size < 1024 * 1024 * 1024) {
      return (size / (1024 * 1024)).toFixed(2) + ' MB';
    } else {
      return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
  }

  onMount(async () => {
    // Get platform information
    platform = await window.electronAPI.app.getOS();

    isOnline = await window.electronAPI.app.isOnline();
    if (!isOnline) {
      loading = false;
      return;
    }

    try {
      await loadCustomStoreData();
    } catch (ex) {
      console.error(ex);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: `Failed to fetch store page`,
        type: 'error',
      });
      currentStorePageOpened.set(undefined);
      currentStorePageOpenedStorefront.set(undefined);
    }
  });

  // Group results by addon
  let resultsByAddon = $derived.by(() => {
    const grouped: Array<{
      addonId: string;
      addonName: string;
      results: SearchResultWithAddon[];
    }> = [];

    const addonMap = new Map<string, SearchResultWithAddon[]>();

    results.forEach((result) => {
      if (!addonMap.has(result.addonSource)) {
        addonMap.set(result.addonSource, []);
      }
      addonMap.get(result.addonSource)!.push(result);
    });

    addonMap.forEach((results, addonId) => {
      grouped.push({
        addonId,
        addonName: addonId, // Using addonId as name for now
        results,
      });
    });

    return grouped;
  });

  async function loadCustomStoreData() {
    results = [];
    alreadyOwns = window.electronAPI.fs.exists('./library/' + appID + '.json');
    originalExecutable = window.electronAPI.fs.read(
      './library/' + appID + '.json'
    );
    if (alreadyOwns && originalExecutable) {
      originalExecutable = JSON.parse(originalExecutable).launchExecutable;
    } else {
      originalExecutable = undefined;
    }
    const response: StoreData | undefined = await safeFetch(
      'gameDetails',
      {
        gameID: String(appID),
        storefront,
      },
      { consume: 'json' }
    );

    gameData = response;
    loading = false;

    // Fetch search results for custom store
    // if (alreadyOwns) return;

    let addons = await fetchAddonsWithConfigure();
    queryingSources = true;

    if (addons.length === 0) {
      queryingSources = false;
      return;
    }

    // Reset loading states
    loadingAddons = new Set(addons.map((addon) => addon.id));
    emptyAddons = new Set();

    const searchPromises = [];
    for (const addon of addons) {
      if (
        !addon.storefronts.includes(storefront) &&
        !addon.storefronts.includes('*')
      ) {
        loadingAddons.delete(addon.id);
        continue;
      }

      searchPromises.push(
        safeFetch(
          'search',
          {
            addonID: addon.id,
            appID: appID,
            storefront: storefront,
            for: alreadyOwns ? 'task' : 'game',
          },
          { consume: 'json' }
        )
          .then((searchResults) => {
            const mappedResults = searchResults.map((result: SearchResult) => {
              return {
                ...result,
                coverImage: (gameData as StoreData).coverImage,
                capsuleImage: (gameData as StoreData).capsuleImage,
                name: result.name,
                addonSource: addon.id,
                storefront: storefront,
              };
            });

            if (mappedResults.length > 0) {
              // Remove from loading set immediately for addons with results
              loadingAddons.delete(addon.id);
              loadingAddons = new Set(loadingAddons);

              results = [...results, ...mappedResults];
            } else {
              // For empty results, add to empty set and animate out after delay
              emptyAddons.add(addon.id);
              emptyAddons = new Set(emptyAddons);

              setTimeout(() => {
                loadingAddons.delete(addon.id);
                loadingAddons = new Set(loadingAddons);

                // Clean up empty addon after another delay
                setTimeout(() => {
                  emptyAddons.delete(addon.id);
                  emptyAddons = new Set(emptyAddons);
                }, 300);
              }, 1000);
            }
          })
          .catch((ex) => {
            // Remove from loading set even on error
            loadingAddons.delete(addon.id);
            loadingAddons = new Set(loadingAddons);
            console.error(ex);
          })
      );
    }
    await Promise.allSettled(searchPromises);
    queryingSources = false;
    // Ensure all addons are removed from loading state
    loadingAddons = new Set();
  }

  function playGame() {
    if (!gameData) return;

    const gameID = (gameData as StoreData).appID;

    console.log('Playing game with ID: ' + gameID);
    selectedView.set('library');
    viewOpenedWhenChanged.set('library');
    currentStorePageOpened.set(undefined);
    currentStorePageOpenedStorefront.set(undefined);
    gameFocused.set(gameID);
    setTimeout(() => {
      launchGameTrigger.set(gameID);
    }, 5);
  }

  function showSourceInfo(result: SearchResultWithAddon) {
    console.log('Showing source info for: ' + result.addonSource);
    selectedResult = result;
  }

  function handleDownloadClick(
    result: SearchResultWithAddon,
    event: MouseEvent
  ) {
    // Check if there's already an active download for this game
    if (activeDownload) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: `Download already in progress for ${gameData?.name}`,
        type: 'warning',
      });
      return;
    }

    // Proceed with download
    if (result.downloadType === 'task') {
      runTask(result, alreadyOwns ? originalFilePath || '' : '');
    } else {
      startDownload(
        {
          ...result,
          name: (gameData as StoreData).name!,
        },
        appID,
        event
      );
    }
  }

  function closeInfoModal() {
    selectedResult = undefined;
  }

  async function removeGame() {
    if (!gameData) return;

    try {
      await window.electronAPI.app.removeApp(appID);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: `${gameData.name} removed from library. (Not deleted from disk)`,
        type: 'success',
      });
      // reload the store page
      // remove the download from the downloads list
      currentDownloads.update((downloads) =>
        downloads.filter((download) => download.appID !== appID)
      );
      loadCustomStoreData();
    } catch (ex) {
      console.error('Failed to remove game:', ex);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: `Failed to remove ${gameData.name} from library`,
        type: 'error',
      });
    }
  }

  function toggleAddonCollapse(addonId: string) {
    if (collapsedAddons.has(addonId)) {
      collapsedAddons.delete(addonId);
    } else {
      collapsedAddons.add(addonId);
    }
    // Trigger reactivity
    collapsedAddons = new Set(collapsedAddons);
  }

  // Watch for download completion and refresh store data
  let matchedDownload = $state(false);
  $effect(() => {
    if (
      activeDownload &&
      (activeDownload.status === 'seeding' ||
        activeDownload.status === 'setup-complete') &&
      !alreadyOwns &&
      !matchedDownload
    ) {
      console.log('Download completed, refreshing store data...');
      // Refresh the alreadyOwns status
      alreadyOwns = window.electronAPI.fs.exists(
        './library/' + appID + '.json'
      );
      matchedDownload = true;
      // Reload store data to reflect the new ownership status
      loadCustomStoreData();

      if (alreadyOwns) {
        // Notify user that the game is now available
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: `${gameData?.name || 'Game'} is now ready to play!`,
          type: 'success',
        });
      }
    }
  });

  // Debug reactive statement
  $effect(() => {
    console.log('Modal state changed - selectedResult:', selectedResult);
  });
</script>

{#if gameData}
  <main class="flex flex-col w-full h-full">
    {#if loading}
      <div class="flex justify-center items-center w-full h-full">
        <div class="loading-container">
          <div class="loading-message" in:fade={{ duration: 300 }}>
            <div class="loading-spinner"></div>
            <p class="text-lg">Loading store page...</p>
          </div>
        </div>
      </div>
    {:else if gameData}
      <!-- Unified Store Layout -->
      <!-- Hero Banner Section -->
      <div class="">
        <div class="relative w-full h-64 overflow-hidden rounded-lg">
          <img
            src={gameData.headerImage}
            alt={gameData.name}
            class="w-full h-full object-cover rounded-lg"
          />
          <!-- Overlay with game info -->
          <div
            class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-6 rounded-b-lg"
          >
            <h1 class="text-4xl font-archivo font-bold text-white mb-2">
              {gameData.name}
            </h1>
            <div class="text-sm text-gray-200">
              <span class="text-gray-300">Publisher:</span>
              {(gameData.publishers ?? []).join(', ')}
              <span class="mx-4"></span>
              <span class="text-gray-300">Developer:</span>
              {(gameData.developers ?? []).join(', ')}
              <br />
              <span class="text-gray-300">Release Date:</span>
              {gameData.releaseDate}
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
              {@html gameData.description}
            </article>
          </div>
        </div>

        <!-- Right sidebar -->
        <div class="w-80 flex flex-col pt-4">
          <!-- Active Download Progress -->
          {#if activeDownload && !alreadyOwns}
            <div class="p-6 bg-accent-lighter rounded-lg mb-4">
              <div class="flex items-center justify-between mb-3">
                <h3 class="font-medium text-accent-dark">Downloading</h3>
                <span class="text-sm text-gray-600">
                  {activeDownload.status === 'downloading' ||
                  activeDownload.status === 'rd-downloading'
                    ? Math.round(activeDownload.progress * 100) + '%'
                    : activeDownload.status === 'merging'
                      ? 'Merging files...'
                      : activeDownload.status === 'completed' ||
                          activeDownload.status === 'redistr-downloading'
                        ? 'Setting up...'
                        : activeDownload.status === 'paused'
                          ? 'Paused'
                          : activeDownload.status === 'requesting'
                            ? 'Requesting...'
                            : activeDownload.status}
                </span>
              </div>

              <!-- Progress Bar -->
              <div class="w-full bg-accent-light rounded-full h-2 mb-3">
                <div
                  class="bg-accent h-2 rounded-full transition-all duration-300 ease-out"
                  style="width: {activeDownload.status === 'completed'
                    ? 100
                    : activeDownload.progress * 100 + '%'}"
                ></div>
              </div>

              <!-- Download Stats -->
              {#if activeDownload.status === 'downloading' || activeDownload.status === 'rd-downloading' || activeDownload.status === 'merging'}
                <div class="flex justify-between text-xs text-accent-dark">
                  <span>
                    {#if activeDownload.downloadSpeed > 0}
                      {formatSpeed(activeDownload.downloadSpeed)}
                    {:else}
                      Connecting...
                    {/if}
                  </span>
                  <span>
                    {#if activeDownload.downloadSize > 0}
                      {formatSize(activeDownload.downloadSize)}
                    {:else}
                      Size unknown
                    {/if}
                  </span>
                </div>

                {#if activeDownload.queuePosition && activeDownload.queuePosition > 1}
                  <div class="text-xs text-gray-500 mt-1">
                    Queue position: {activeDownload.queuePosition === 999
                      ? '-'
                      : activeDownload.queuePosition}
                  </div>
                {/if}
              {/if}

              <!-- Source Info -->
              <div class="flex items-center gap-2 mt-3 pt-3">
                <AddonPicture
                  addonId={activeDownload.addonSource}
                  class="w-6 h-6 rounded"
                />
                <span class="text-sm text-gray-700"
                  >{activeDownload.addonSource}</span
                >
              </div>
            </div>
          {:else}
            <div class="flex-1 overflow-y-auto">
              <!-- Sources Section -->
              {#if alreadyOwns}
                <div class="p-6 bg-accent-lighter rounded-lg mb-4">
                  <button
                    class="w-full border-none {!isWin32Only
                      ? 'bg-accent-light hover:bg-opacity-80 text-accent-dark'
                      : 'bg-gray-300 text-gray-500 cursor-not-allowed'} font-medium py-3 px-4 rounded-lg transition-colors duration-200 {isWin32Only
                      ? 'mb-3'
                      : ''}"
                    class:disabled={isWin32Only}
                    disabled={isWin32Only}
                    title={isWin32Only ? '' : 'Use Steam to Launch Your Games'}
                    onclick={() => !isWin32Only && playGame()}
                  >
                    Play Game
                  </button>

                  {#if isWin32Only}
                    <button
                      class="w-full border-none bg-red-100 hover:bg-red-200 text-red-700 font-medium py-3 px-4 rounded-lg transition-colors duration-200"
                      onclick={() => removeGame()}
                    >
                      Remove from Library
                    </button>
                  {/if}
                </div>
              {/if}
              <!-- Loading indicators for addons still searching -->
              {#each Array.from(loadingAddons) as addonId, index (addonId)}
                {@const isEmpty = emptyAddons.has(addonId)}
                <div
                  class="bg-accent-lighter rounded-lg p-4 mb-4 opacity-75"
                  class:opacity-50={isEmpty}
                  in:fly={{ y: 30, duration: 400, delay: 50 * index }}
                >
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                      <AddonPicture {addonId} class="w-12 h-12 rounded-lg" />
                      <div>
                        <h3 class="font-medium text-gray-800">{addonId}</h3>
                        {#if isEmpty}
                          <span class="text-sm text-gray-500 font-medium italic"
                            >No results found</span
                          >
                        {:else}
                          <span class="text-sm text-gray-500 font-medium italic"
                            >Searching...</span
                          >
                        {/if}
                      </div>
                    </div>
                    {#if !isEmpty}
                      <div
                        class="w-5 h-5 border-2 border-gray-300 border-t-accent rounded-full animate-spin"
                      ></div>
                    {:else}
                      <svg
                        class="w-5 h-5 text-gray-400"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
                        <line x1="9" y1="9" x2="9.01" y2="9" />
                        <line x1="15" y1="9" x2="15.01" y2="9" />
                      </svg>
                    {/if}
                  </div>
                </div>
              {/each}

              <!-- Actual results grouped by addon -->
              {#if resultsByAddon.length > 0}
                {#each resultsByAddon.filter( (group) => group.results.some((result) => !alreadyOwns || result.downloadType === 'task') ) as addonGroup, groupIndex (addonGroup.addonId)}
                  {@const filteredResults = addonGroup.results.filter(
                    (result) => !alreadyOwns || result.downloadType === 'task'
                  )}
                  {#if filteredResults.length > 0}
                    <div
                      class="mb-4"
                      in:fly={{ y: 30, duration: 400, delay: 100 * groupIndex }}
                    >
                      <!-- Addon Section Header -->
                      <button
                        class="w-full flex items-center justify-between p-3 bg-accent-lighter hover:bg-accent-light/80 border-none cursor-pointer rounded-lg transition-colors duration-200 mb-2"
                        onclick={() => toggleAddonCollapse(addonGroup.addonId)}
                      >
                        <div class="flex items-center gap-3">
                          <AddonPicture
                            addonId={addonGroup.addonId}
                            class="w-10 h-10 rounded-lg"
                          />
                          <div class="text-left">
                            <h3 class="font-medium text-gray-800 text-sm">
                              {addonGroup.addonName}
                            </h3>
                            <span class="text-xs text-gray-600"
                              >{filteredResults.length} result{filteredResults.length ===
                              1
                                ? ''
                                : 's'}</span
                            >
                          </div>
                        </div>
                        <svg
                          class="w-4 h-4 text-gray-600 transition-transform duration-200"
                          class:rotate-180={!collapsedAddons.has(
                            addonGroup.addonId
                          )}
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M19 9l-7 7-7-7"
                          />
                        </svg>
                      </button>

                      <!-- Results with left padding -->
                      {#if !collapsedAddons.has(addonGroup.addonId)}
                        <div class="pl-4" transition:slide={{ duration: 300 }}>
                          {#each filteredResults as result, index}
                            <div
                              class="bg-accent-lighter rounded-lg p-3 mb-3 last:mb-0"
                              in:fly={{
                                y: 20,
                                duration: 300,
                                delay: 50 * index,
                              }}
                            >
                              <div
                                class="flex items-center justify-between mb-2"
                              >
                                <span class="font-medium text-gray-800 text-sm"
                                  >{result.name.slice(0, 25)}{result.name
                                    .length > 25
                                    ? '...'
                                    : ''}</span
                                >
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
                                  {:else if result.downloadType === 'task'}
                                    <span>Task</span>
                                  {/if}
                                </div>
                              </div>
                              <div class="flex flex-row gap-2">
                                <button
                                  class="flex-1 text-sm border-none {activeDownload &&
                                  !alreadyOwns
                                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                                    : 'bg-accent-light hover:bg-opacity-80 text-accent-dark'} font-medium py-3 px-3 rounded-lg flex items-center justify-center gap-2 transition-colors duration-200"
                                  disabled={(results.length === 0 &&
                                    !queryingSources) ||
                                    (activeDownload && !alreadyOwns)}
                                  onclick={(event) =>
                                    handleDownloadClick(result, event)}
                                >
                                  {activeDownload && !alreadyOwns
                                    ? 'Download in Progress'
                                    : result.downloadType === 'task'
                                      ? 'Run Task'
                                      : 'Download'}
                                </button>
                                <button
                                  class="text-sm border-none w-12 bg-accent-light hover:bg-opacity-80 text-accent-dark font-medium py-3 rounded-lg flex items-center justify-center gap-2 transition-colors duration-200"
                                  aria-label="Source Information"
                                  onclick={() => showSourceInfo(result)}
                                >
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    class="fill-accent-dark w-5 h-5"
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
                        </div>
                      {/if}
                    </div>
                  {/if}
                {/each}
              {:else if queryingSources && loadingAddons.size === 0}
                <div class="text-center py-8">
                  <div
                    class="animate-spin w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full mx-auto mb-3"
                  ></div>
                  <p class="text-gray-600">Searching sources...</p>
                </div>
              {:else if !queryingSources && resultsByAddon.length === 0 && loadingAddons.size === 0}
                <div class="text-center py-8">
                  <p class="text-gray-600">
                    {alreadyOwns
                      ? 'No tasks available'
                      : 'No sources available'}
                  </p>
                </div>
              {/if}
            </div>
          {/if}
        </div>
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
{:else if !loading}
  <div class="flex flex-col gap-2 w-full justify-center items-center h-full">
    <img src="./favicon.png" alt="content" class="w-32 h-32" />
    <h1 class="text-2xl text-black">Game not found</h1>
    <h1 class="text-lg text-gray-500 text-center">
      The game you're looking for is not available.
    </h1>
  </div>
{:else}
  <div class="flex justify-center items-center w-full h-full">
    <div class="loading-container">
      <div class="loading-message" in:fade={{ duration: 300 }}>
        <div class="loading-spinner"></div>
        <p class="text-lg">Loading store page...</p>
      </div>
    </div>
  </div>
{/if}

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
                {:else if selectedResult.downloadType === 'task'}
                  <span class="text-sm font-medium">Task</span>
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
