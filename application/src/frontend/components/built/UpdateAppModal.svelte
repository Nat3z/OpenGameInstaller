<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchAddonsWithConfigure,
    safeFetch,
    startDownload,
    type SearchResultWithAddon,
  } from '../../utils';
  import { createNotification } from '../../store';
  import type { LibraryInfo, SearchResult, StoreData } from 'ogi-addon';
  import AddonPicture from '../AddonPicture.svelte';
  import Modal from '../modal/Modal.svelte';
  import TitleModal from '../modal/TitleModal.svelte';
  import SectionModal from '../modal/SectionModal.svelte';
  import { fly, slide } from 'svelte/transition';

  interface Props {
    libraryInfo: LibraryInfo;
    updateVersion: string;
    onClose: () => void;
  }

  let { libraryInfo, updateVersion, onClose }: Props = $props();

  let { appID, storefront, name: gameName } = $derived(libraryInfo);

  let results: SearchResultWithAddon[] = $state([]);
  let gameData: StoreData | undefined = $state();
  let loading = $state(true);
  let queryingSources = $state(false);
  let loadingAddons: Set<string> = $state(new Set());
  let emptyAddons: Set<string> = $state(new Set());
  let collapsedAddons: Set<string> = $state(new Set());

  onMount(async () => {
    const isOnline = await window.electronAPI.app.isOnline();
    if (!isOnline) {
      loading = false;
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'You are offline. Cannot fetch update sources.',
        type: 'error',
      });
      return;
    }

    try {
      await loadUpdateSources();
    } catch (ex) {
      console.error(ex);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Failed to fetch update sources',
        type: 'error',
      });
    }
  });

  type AddonGroup = {
    addonId: string;
    addonName: string;
    results: SearchResultWithAddon[];
  };

  // Group results by addon, separating recommended (original addon source) from others
  let groupedResults = $derived.by(() => {
    const addonMap = new Map<string, SearchResultWithAddon[]>();

    results.forEach((result) => {
      if (!addonMap.has(result.addonSource)) {
        addonMap.set(result.addonSource, []);
      }
      addonMap.get(result.addonSource)!.push(result);
    });

    const originalAddonSource = libraryInfo.addonsource;
    let recommendedAddon: AddonGroup | null = null;
    const otherAddons: AddonGroup[] = [];

    addonMap.forEach((results, addonId) => {
      const addonGroup: AddonGroup = {
        addonId,
        addonName: addonId,
        results,
      };

      if (addonId === originalAddonSource) {
        recommendedAddon = addonGroup;
      } else {
        otherAddons.push(addonGroup);
      }
    });

    return { recommendedAddon, otherAddons };
  });

  let recommendedAddon = $derived(groupedResults.recommendedAddon);
  let otherAddons = $derived(groupedResults.otherAddons);

  async function loadUpdateSources() {
    results = [];

    // Fetch game details for images
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
            for: 'update',
            addonID: addon.id,
            appID,
            storefront,
            libraryInfo: JSON.parse(JSON.stringify(libraryInfo)),
          },
          { consume: 'json' }
        )
          .then((searchResults) => {
            const mappedResults = searchResults.map((result: SearchResult) => {
              return {
                ...result,
                coverImage: gameData?.coverImage ?? '',
                capsuleImage: gameData?.capsuleImage ?? '',
                name: result.name,
                addonSource: addon.id,
                storefront: storefront,
              };
            });

            if (mappedResults.length > 0) {
              loadingAddons.delete(addon.id);
              loadingAddons = new Set(loadingAddons);
              results = [...results, ...mappedResults];
            } else {
              emptyAddons.add(addon.id);
              emptyAddons = new Set(emptyAddons);

              setTimeout(() => {
                loadingAddons.delete(addon.id);
                loadingAddons = new Set(loadingAddons);

                setTimeout(() => {
                  emptyAddons.delete(addon.id);
                  emptyAddons = new Set(emptyAddons);
                }, 300);
              }, 1000);
            }
          })
          .catch((ex) => {
            loadingAddons.delete(addon.id);
            loadingAddons = new Set(loadingAddons);
            console.error(ex);
          })
      );
    }
    collapsedAddons = new Set();
    addons.forEach((addon) => {
      collapsedAddons.add(addon.id);
    });
    collapsedAddons = new Set(collapsedAddons);
    await Promise.allSettled(searchPromises);
    queryingSources = false;
    loadingAddons = new Set();
  }

  async function handleDownloadClick(
    result: SearchResultWithAddon,
    event: MouseEvent
  ) {
    // Add update flags to the result before starting download
    const updateResult = {
      ...result,
      name: gameName,
      isUpdate: true,
      updateVersion: updateVersion,
    } as SearchResultWithAddon & { isUpdate: boolean; updateVersion: string };

    startDownload(updateResult, appID, event);
    onClose();

    createNotification({
      id: Math.random().toString(36).substring(7),
      message: `Starting update download for ${gameName}`,
      type: 'info',
    });
  }

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

  function toggleAddonCollapse(addonId: string) {
    if (collapsedAddons.has(addonId)) {
      collapsedAddons.delete(addonId);
    } else {
      collapsedAddons.add(addonId);
    }
    collapsedAddons = new Set(collapsedAddons);
  }
</script>

<Modal open={true} size="medium" {onClose}>
  <TitleModal title="Update {gameName}" />

  <p class="text-sm text-gray-600 mt-1 mb-4">
    Select a source to download version <span
      class="font-semibold text-accent-dark">{updateVersion}</span
    >
  </p>

  <SectionModal
    scrollable={true}
    class="max-h-96 bg-transparent! p-0! border-0!"
  >
    {#if loading}
      <div class="flex justify-center items-center py-8">
        <div
          class="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin"
        ></div>
        <p class="ml-3 text-gray-600">Loading sources...</p>
      </div>
    {:else}
      <!-- Loading indicators for addons still searching -->
      {#each Array.from(loadingAddons) as addonId, index (addonId)}
        {@const isEmpty = emptyAddons.has(addonId)}
        <div
          class="bg-accent-lighter rounded-lg p-4 mb-1 opacity-75"
          class:opacity-50={isEmpty}
          in:fly={{ y: 20, duration: 300, delay: 50 * index }}
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <AddonPicture {addonId} class="w-10 h-10 rounded-lg" />
              <div>
                <h3 class="font-medium text-gray-800 text-sm">{addonId}</h3>
                {#if isEmpty}
                  <span class="text-xs text-gray-500 italic"
                    >No results found</span
                  >
                {:else}
                  <span class="text-xs text-gray-500 italic">Searching...</span>
                {/if}
              </div>
            </div>
            {#if !isEmpty}
              <div
                class="w-4 h-4 border-2 border-gray-300 border-t-accent rounded-full animate-spin"
              ></div>
            {/if}
          </div>
        </div>
      {/each}

      <!-- Results grouped by addon -->
      {#if recommendedAddon || otherAddons.length > 0}
        <!-- Recommended Section -->
        {#if recommendedAddon}
          {@const recAddon = recommendedAddon as AddonGroup}
          <div class="mb-3">
            <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 px-1">Recommended</h4>
            <div
              class="mb-0"
              in:fly={{ y: 20, duration: 300 }}
            >
              <!-- Addon Section Header -->
              <button
                class="w-full flex items-center justify-between p-3 bg-accent-light/60 hover:bg-accent-light border-none cursor-pointer rounded-lg transition-colors duration-200 mb-1"
                onclick={() => toggleAddonCollapse(recAddon.addonId)}
              >
                <div class="flex items-center gap-3">
                  <AddonPicture
                    addonId={recAddon.addonId}
                    class="w-8 h-8 rounded-lg"
                  />
                  <div class="text-left">
                    <h3 class="font-medium text-gray-800 text-sm">
                      {recAddon.addonName}
                    </h3>
                    <span class="text-xs text-gray-600">
                      {recAddon.results.length} source{recAddon.results
                        .length === 1
                        ? ''
                        : 's'}
                    </span>
                  </div>
                </div>
                <svg
                  class="w-4 h-4 text-gray-600 transition-transform duration-200"
                  class:rotate-180={!collapsedAddons.has(recAddon.addonId)}
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

              <!-- Results -->
              {#if !collapsedAddons.has(recAddon.addonId)}
                <div transition:slide={{ duration: 250 }}>
                  {#each recAddon.results as result, index}
                    <div
                      class="bg-accent-lighter/60 rounded-lg p-3 mb-1 last:mb-0"
                      in:fly={{ y: 15, duration: 250, delay: 40 * index }}
                    >
                      <div class="flex items-center justify-between mb-2">
                        <span
                          class="font-medium text-gray-800 text-sm truncate max-w-[200px]"
                        >
                          {result.name}
                        </span>
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
                          {#if result.sizeInBytes != null && result.sizeInBytes > 0}
                            <span>· {formatSize(result.sizeInBytes)}</span>
                          {/if}
                        </div>
                      </div>
                      <button
                        class="w-full text-sm border-none bg-accent-light hover:bg-accent/30 text-accent-dark font-medium py-2 px-3 rounded-lg transition-colors duration-200"
                        onclick={(event) => handleDownloadClick(result, event)}
                      >
                        Download Update
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}

        <!-- Other Sources Section -->
        {#if otherAddons.length > 0}
          <div>
            <h4 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 px-1">Other Sources</h4>
            {#each otherAddons as addonGroup, groupIndex (addonGroup.addonId)}
              <div
                class="mb-0"
                in:fly={{ y: 20, duration: 300, delay: 80 * groupIndex }}
              >
                <!-- Addon Section Header -->
                <button
                  class="w-full flex items-center justify-between p-3 bg-accent-lighter hover:bg-accent-light/80 border-none cursor-pointer rounded-lg transition-colors duration-200 mb-1"
                  onclick={() => toggleAddonCollapse(addonGroup.addonId)}
                >
                  <div class="flex items-center gap-3">
                    <AddonPicture
                      addonId={addonGroup.addonId}
                      class="w-8 h-8 rounded-lg"
                    />
                    <div class="text-left">
                      <h3 class="font-medium text-gray-800 text-sm">
                        {addonGroup.addonName}
                      </h3>
                      <span class="text-xs text-gray-600">
                        {addonGroup.results.length} source{addonGroup.results
                          .length === 1
                          ? ''
                          : 's'}
                      </span>
                    </div>
                  </div>
                  <svg
                    class="w-4 h-4 text-gray-600 transition-transform duration-200"
                    class:rotate-180={!collapsedAddons.has(addonGroup.addonId)}
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

                <!-- Results -->
                {#if !collapsedAddons.has(addonGroup.addonId)}
                  <div transition:slide={{ duration: 250 }}>
                    {#each addonGroup.results as result, index}
                      <div
                        class="bg-accent-lighter/60 rounded-lg p-3 mb-1 last:mb-0"
                        in:fly={{ y: 15, duration: 250, delay: 40 * index }}
                      >
                        <div class="flex items-center justify-between mb-2">
                          <span
                            class="font-medium text-gray-800 text-sm truncate max-w-[200px]"
                          >
                            {result.name}
                          </span>
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
                            {#if result.sizeInBytes != null && result.sizeInBytes > 0}
                              <span>· {formatSize(result.sizeInBytes)}</span>
                            {/if}
                          </div>
                        </div>
                        <button
                          class="w-full text-sm border-none bg-accent-light hover:bg-accent/30 text-accent-dark font-medium py-2 px-3 rounded-lg transition-colors duration-200"
                          onclick={(event) => handleDownloadClick(result, event)}
                        >
                          Download Update
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else if !queryingSources && loadingAddons.size === 0}
        <div class="text-center py-8">
          <svg
            class="w-12 h-12 mx-auto text-gray-400 mb-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <circle cx="12" cy="12" r="10" stroke-width="2" />
            <path d="M8 12h8M12 8v8" stroke-width="2" stroke-linecap="round" />
          </svg>
          <p class="text-gray-600">No update sources available</p>
          <p class="text-sm text-gray-500 mt-1">
            Try again later or check your addons
          </p>
        </div>
      {/if}
    {/if}
  </SectionModal>

  <div class="flex justify-end mt-4">
    <button
      class="px-4 py-2 bg-accent-lighter hover:bg-accent-light text-accent-dark font-medium rounded-lg border-none transition-colors duration-200"
      onclick={onClose}
    >
      Cancel
    </button>
  </div>
</Modal>
