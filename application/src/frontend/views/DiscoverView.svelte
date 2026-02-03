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
    wishlist,
  } from '../store';
  import { removeFromWishlist } from '../lib/core/wishlist';
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
  let allSections = $state<AllSections[]>([]);
  let carouselIndices = $state<Record<string, number>>({}); // sectionId -> page index
  let carouselDirections = $state<Record<string, number>>({}); // sectionId -> direction (-1 or 1)

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

  // Reset carousel indices when allSections change
  $effect(() => {
    const indices: Record<string, number> = {};
    const directions: Record<string, number> = {};
    allSections.forEach((section) => {
      indices[section.sectionId] = 0;
      directions[section.sectionId] = 0;
    });
    carouselIndices = indices;
    carouselDirections = directions;
  });

  function handleCarouselNav(
    sectionId: string,
    direction: number,
    maxPage: number
  ) {
    carouselDirections = { ...carouselDirections, [sectionId]: direction };
    // Animate, then update index
    setTimeout(() => {
      carouselIndices = {
        ...carouselIndices,
        [sectionId]: Math.max(
          0,
          Math.min((carouselIndices[sectionId] || 0) + direction, maxPage)
        ),
      };
      // Reset direction after content changes
      setTimeout(() => {
        carouselDirections = { ...carouselDirections, [sectionId]: 0 };
      }, 50);
    }, 150);
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

  function removeFromWishlistClick(game: BasicLibraryInfo, e: MouseEvent) {
    e.stopPropagation();
    removeFromWishlist(game.appID, game.storefront);
  }

  onMount(() => {
    loadCatalogs();
  });
</script>

<div class="flex flex-col w-full h-full overflow-y-auto gap-6 pb-8">
  <!-- Header Section -->
  <div class="bg-accent-lighter px-6 py-4 rounded-lg">
    <div>
      <h1 class="text-2xl font-semibold text-accent-dark mb-2">
        Discover Games
      </h1>
      <p class="text-accent">
        Browse curated game collections from your installed addons
      </p>
    </div>
  </div>

  <!-- Your wishlist section (at top) -->
  {#if $wishlist.length > 0}
    <div class="space-y-3 px-4">
      <div class="bg-accent-lighter px-4 py-3 rounded-lg">
        <h3 class="text-lg font-semibold text-accent-dark">Your wishlist</h3>
        <p class="text-accent-dark text-sm mt-1">
          {$wishlist.length} game{$wishlist.length === 1 ? '' : 's'} saved for later
        </p>
      </div>
      <div class="flex flex-row gap-3 flex-wrap">
        {#each $wishlist as game (`${game.appID}-${game.storefront}`)}
          <div
            class="w-32 flex flex-col rounded-lg overflow-hidden bg-white shadow-md hover:shadow-lg transition-shadow"
          >
            <button
              class="group w-32 h-48 relative border-none p-0 cursor-pointer text-left bg-transparent block"
              onclick={() => openGameStorePage(game)}
              aria-label={game.name}
            >
              <div class="relative w-full h-full">
                <img
                  src={game.capsuleImage}
                  alt={game.name}
                  class="w-32 h-48 object-cover"
                  loading="lazy"
                  onerror={(e) => {
                    const fallback = './favicon.png';
                    const img = e.currentTarget as HTMLImageElement;
                    if (img.src !== fallback) {
                      img.src = fallback;
                      img.style.opacity = '0.5';
                    }
                  }}
                />
                <div
                  class="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent p-1.5"
                >
                  <h4
                    class="text-white text-xs font-medium truncate leading-tight"
                  >
                    {game.name}
                  </h4>
                </div>
              </div>
            </button>
            <div class="flex flex-row gap-1 p-2 bg-accent-lighter">
              <button
                class="flex-1 text-xs border-none bg-accent-light hover:bg-accent-light/80 text-accent-dark font-medium py-2 px-2 rounded transition-colors"
                onclick={() => openGameStorePage(game)}
              >
                View
              </button>
              <button
                class="border-none bg-transparent hover:bg-red-100 text-gray-600 hover:text-red-600 p-2 rounded transition-colors"
                aria-label="Remove from wishlist"
                onclick={(e) => removeFromWishlistClick(game, e)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5">
                  <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
                </svg>
              </button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <div class="space-y-3 px-4">
      <div class="bg-accent-lighter px-4 py-3 rounded-lg">
        <h3 class="text-lg font-semibold text-accent-dark">Your wishlist</h3>
        <p class="text-accent-dark text-sm mt-1">
          Games you add from search or store will appear here.
        </p>
      </div>
    </div>
  {/if}

  {#if loading}
    <!-- Skeleton Loading State -->
    <div class="space-y-6">
      {#each [1, 2] as sectionIndex}
        <div class="space-y-3 px-4">
          <!-- Skeleton Section Header -->
          <div class="bg-accent-lighter px-4 py-3 rounded-lg">
            <div class="flex items-center gap-3 mb-2">
              <div class="skeleton w-8 h-8 rounded"></div>
              <div class="flex-1">
                <div class="skeleton h-5 w-32 mb-1"></div>
                <div class="skeleton h-3 w-24"></div>
              </div>
            </div>
            <div class="skeleton h-4 w-48 mt-2"></div>
          </div>

          <!-- Skeleton Games Carousel -->
          <div class="relative flex items-center w-full">
            <div
              class="flex flex-row gap-3 w-full justify-center overflow-hidden px-10"
              style="min-height: 200px;"
            >
              {#each [1, 2, 3, 4, 5] as gameIndex}
                <div
                  class="w-32 h-48 skeleton rounded-lg"
                  style="animation-delay: {(sectionIndex - 1) * 200 +
                    gameIndex * 100}ms"
                ></div>
              {/each}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {:else if allSections.length === 0}
    <div class="flex flex-col gap-4 w-full justify-center items-center py-16">
      <img src="./favicon.png" alt="content" class="w-24 h-24 opacity-50" />
      <div class="text-center">
        <h2 class="text-xl text-gray-600 mb-2">No catalogs available</h2>
        <p class="text-gray-500">
          Install addons that support catalog browsing to see game collections
        </p>
      </div>
    </div>
  {:else}
    <!-- Catalog Content -->
    <div class="space-y-6">
      {#each allSections as sectionItem}
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

          <!-- Games Carousel -->
          {#if sectionItem.section.listings.length > 0}
            <div class="relative flex items-center w-full">
              <!-- Left Arrow -->
              <button
                class="absolute left-0 z-10 bg-accent-lighter hover:bg-accent-light text-accent-dark rounded-full w-8 h-8 flex items-center justify-center shadow transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-none"
                style="top: 50%; transform: translateY(-50%);"
                onclick={() =>
                  handleCarouselNav(
                    sectionItem.sectionId,
                    -1,
                    Math.floor((sectionItem.section.listings.length - 1) / 5)
                  )}
                disabled={carouselIndices[sectionItem.sectionId] === 0}
                aria-label="Previous games"
              >
                <svg
                  class="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  viewBox="0 0 24 24"
                  ><path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M15 19l-7-7 7-7"
                  /></svg
                >
              </button>

              <!-- Carousel Items -->
              <div
                class="flex flex-row gap-3 w-full justify-center overflow-hidden px-10"
                style="min-height: 200px;"
              >
                <div
                  class="flex flex-row gap-3 w-full transition-transform duration-300 ease-in-out"
                  style="transform: translateX({carouselDirections[
                    sectionItem.sectionId
                  ] * -20}px);"
                >
                  {#each sectionItem.section.listings.slice(carouselIndices[sectionItem.sectionId] * 5, carouselIndices[sectionItem.sectionId] * 5 + 5) as game (game.appID)}
                    <button
                      class="group w-32 h-48 relative border-none transition-all duration-200 shadow-md hover:shadow-lg rounded-lg overflow-hidden bg-white transform hover:scale-102 hover:-translate-y-0.5"
                      onclick={() => openGameStorePage(game)}
                      aria-label={game.name}
                    >
                      <div class="relative">
                        <img
                          src={game.capsuleImage}
                          alt={game.name}
                          class="w-32 h-48 object-cover"
                          loading="lazy"
                          onerror={(e) => {
                            const fallback = './favicon.png';
                            const img = e.currentTarget as HTMLImageElement;
                            if (img.src !== fallback) {
                              img.src = fallback;
                              img.style.opacity = '0.5';
                            }
                          }}
                        />
                        <!-- Overlay with game info -->
                        <div
                          class="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent p-1.5"
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
              </div>

              <!-- Right Arrow -->
              <button
                class="absolute right-0 z-10 bg-accent-lighter hover:bg-accent-light text-accent-dark rounded-full w-8 h-8 flex items-center justify-center shadow transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-none"
                style="top: 50%; transform: translateY(-50%);"
                onclick={() =>
                  handleCarouselNav(
                    sectionItem.sectionId,
                    1,
                    Math.floor((sectionItem.section.listings.length - 1) / 5)
                  )}
                disabled={carouselIndices[sectionItem.sectionId] >=
                  Math.floor((sectionItem.section.listings.length - 1) / 5)}
                aria-label="Next games"
              >
                <svg
                  class="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  viewBox="0 0 24 24"
                  ><path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M9 5l7 7-7 7"
                  /></svg
                >
              </button>
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
  button:hover {
    box-shadow:
      0 20px 40px 0 rgba(0, 0, 0, 0.15),
      0 4px 10px 0 rgba(0, 0, 0, 0.1);
  }
</style>
