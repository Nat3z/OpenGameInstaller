<script lang="ts">
  import { onMount } from 'svelte';
  import { safeFetch } from '../utils';
  import type { BasicLibraryInfo, OGIAddonConfiguration } from 'ogi-addon';
  import type { ConfigurationFile } from 'ogi-addon/config';
  import {
    currentStorePageOpened,
    currentStorePageOpenedStorefront,
    viewOpenedWhenChanged,
    selectedView,
    createNotification,
  } from '../store';
  import AddonPicture from '../components/AddonPicture.svelte';

  interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
    configTemplate: ConfigurationFile;
  }

  interface CatalogSection {
    name: string;
    description: string;
    listings: BasicLibraryInfo[];
  }

  interface AddonCatalog {
    addonId: string;
    addonName: string;
    sections: Record<string, CatalogSection>;
  }

  interface AllSections {
    sectionId: string;
    addonId: string;
    addonName: string;
    section: CatalogSection;
  }

  let addons: ConfigTemplateAndInfo[] = $state([]);
  let catalogs: AddonCatalog[] = $state([]);
  let loading = $state(true);
  let searchQuery = $state('');
  let allSections = $state<AllSections[]>([]);
  let filteredSections = $state<AllSections[]>([]);

  // Flatten all sections from all catalogs
  $effect(() => {
    const sections: AllSections[] = [];
    catalogs.forEach((catalog) => {
      Object.entries(catalog.sections).forEach(([sectionId, section]) => {
        sections.push({
          sectionId,
          addonId: catalog.addonId,
          addonName: catalog.addonName,
          section,
        });
      });
    });
    allSections = sections;
  });

  // Update filtered sections when search query changes
  $effect(() => {
    updateFilteredSections();
  });

  function updateFilteredSections() {
    let filtered = allSections;

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = allSections.filter(
        (item) =>
          item.section.name.toLowerCase().includes(query) ||
          item.section.description.toLowerCase().includes(query) ||
          item.addonName.toLowerCase().includes(query) ||
          item.section.listings.some((listing) =>
            listing.name.toLowerCase().includes(query)
          )
      );
    }

    filteredSections = filtered;
  }

  async function loadCatalogs() {
    try {
      loading = true;
      addons = await safeFetch('getAllAddons', {});

      const catalogPromises = addons.map(async (addon) => {
        try {
          const catalogData = await safeFetch('getCatalogs', {
            addonID: addon.id,
          });

          return {
            addonId: addon.id,
            addonName: addon.name,
            sections: catalogData,
          };
        } catch (error) {
          console.warn(`Failed to load catalog for addon ${addon.id}:`, error);
          return null;
        }
      });

      const results = await Promise.all(catalogPromises);
      catalogs = results.filter(
        (catalog): catalog is AddonCatalog =>
          catalog !== null && Object.keys(catalog.sections).length > 0
      );
    } catch (error) {
      console.error('Failed to load catalogs:', error);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Failed to load catalogs',
        type: 'error',
      });
    } finally {
      loading = false;
    }
  }

  function openGameStorePage(game: BasicLibraryInfo) {
    currentStorePageOpened.set(game.appID);
    currentStorePageOpenedStorefront.set(game.storefront);
    viewOpenedWhenChanged.set($selectedView);
  }

  function chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  onMount(() => {
    loadCatalogs();
  });
</script>

<div class="flex flex-col w-full h-full overflow-y-auto gap-6 pb-8">
  <!-- Header Section -->
  <div class="bg-accent-lighter px-6 py-4 rounded-lg">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-accent-dark mb-2">
          Discover Games
        </h1>
        <p class="text-accent">
          Browse curated game collections from your installed addons
        </p>
      </div>

      <!-- Search Controls -->
      <div class="flex gap-4 items-center">
        <!-- Search Input -->
        <div class="relative">
          <div
            class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"
          >
            <svg
              class="h-4 w-4 text-accent"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              ></path>
            </svg>
          </div>
          <input
            type="text"
            bind:value={searchQuery}
            placeholder="Search catalogs..."
            class="block w-64 pl-9 pr-3 py-2 border border-accent rounded-md text-sm bg-white placeholder-accent focus:outline-none focus:ring-1 focus:ring-accent-dark focus:border-accent-dark transition-colors"
          />
        </div>
      </div>
    </div>
  </div>

  {#if loading}
    <div class="flex justify-center items-center py-16">
      <div
        class="animate-spin rounded-full h-12 w-12 border-b-2 border-accent"
      ></div>
    </div>
  {:else if filteredSections.length === 0}
    <div class="flex flex-col gap-4 w-full justify-center items-center py-16">
      <img src="./favicon.png" alt="content" class="w-24 h-24 opacity-50" />
      <div class="text-center">
        <h2 class="text-xl text-gray-600 mb-2">
          {searchQuery ? 'No matching catalogs found' : 'No catalogs available'}
        </h2>
        <p class="text-gray-500">
          {#if searchQuery}
            Try adjusting your search terms
          {:else}
            Install addons that support catalog browsing to see game collections
          {/if}
        </p>
      </div>
    </div>
  {:else}
    <!-- Catalog Content -->
    <div class="space-y-6">
      {#each filteredSections as sectionItem}
        <div class="space-y-3 px-4">
          <!-- Section Header with Addon Info -->
          <div class="bg-accent-lighter px-4 py-3 rounded-lg">
            <div class="flex items-center gap-3 mb-2">
              <div class="w-8 h-8 rounded overflow-hidden">
                <AddonPicture addonId={sectionItem.addonId} class="rounded" />
              </div>
              <div class="flex-1">
                <h3 class="text-lg font-semibold text-accent-dark">
                  {sectionItem.section.name}
                </h3>
                <div class="flex items-center gap-2 text-xs text-accent">
                  <span>{sectionItem.addonName}</span>
                  <span>•</span>
                  <span
                    >{sectionItem.section.listings.length} game{sectionItem
                      .section.listings.length === 1
                      ? ''
                      : 's'}</span
                  >
                </div>
              </div>
            </div>
            <p class="text-accent-dark text-sm">
              {sectionItem.section.description}
            </p>
          </div>

          <!-- Games Grid -->
          {#if sectionItem.section.listings.length > 0}
            <div class="space-y-3">
              {#each chunkArray(sectionItem.section.listings, 8) as chunk}
                <div class="flex gap-3 flex-wrap">
                  {#each chunk as game}
                    <button
                      class="group relative border-none transition-all duration-200 shadow-md hover:shadow-lg rounded-lg overflow-hidden bg-white transform hover:scale-102 hover:-translate-y-0.5"
                      onclick={() => openGameStorePage(game)}
                    >
                      <div class="relative">
                        <img
                          src={game.capsuleImage}
                          alt={game.name}
                          class="w-32 h-48 object-cover"
                          loading="lazy"
                        />
                        <!-- Overlay with game info -->
                        <div
                          class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5"
                        >
                          <h4
                            class="text-white text-xs font-medium truncate leading-tight"
                          >
                            {game.name}
                          </h4>
                        </div>
                      </div>
                    </button>
                  {/each}
                </div>
              {/each}
            </div>
          {:else}
            <div class="text-center py-6 text-gray-500">
              <p class="text-sm">No games in this collection</p>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .group:hover .group-hover\:scale-110 {
    transform: scale(1.1);
  }

  button:hover {
    box-shadow:
      0 20px 40px 0 rgba(0, 0, 0, 0.15),
      0 4px 10px 0 rgba(0, 0, 0, 0.1);
  }
</style>
