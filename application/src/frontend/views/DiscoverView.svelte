<script lang="ts">
  import { onMount } from 'svelte';
  import { safeFetch } from '../utils';
  import type {
    BasicLibraryInfo,
    CatalogCarouselItem,
    CatalogResponse,
    CatalogSection,
    OGIAddonConfiguration,
  } from 'ogi-addon';
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

  interface AddonCatalog {
    addonId: string;
    addonName: string;
    sections: Record<string, CatalogSection>;
    carouselItems: CatalogCarouselItem[];
  }

  interface AllSections {
    sectionId: string;
    sectionKey: string;
    addonId: string;
    addonName: string;
    section: CatalogSection;
  }

  interface DiscoverCarouselItem extends CatalogCarouselItem {
    addonId: string;
    addonName: string;
  }

  let addons: ConfigTemplateAndInfo[] = $state([]);
  let catalogs: AddonCatalog[] = $state([]);
  let loading = $state(true);
  let allSections = $state<AllSections[]>([]);
  let featuredCarouselItems = $state<DiscoverCarouselItem[]>([]);
  let featuredCarouselIndex = $state(0);
  let carouselIndices = $state<Record<string, number>>({});
  const CAROUSEL_PAGE_SIZE = 5;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function isBasicLibraryInfo(value: unknown): value is BasicLibraryInfo {
    if (!isRecord(value)) return false;
    return (
      typeof value.name === 'string' &&
      typeof value.capsuleImage === 'string' &&
      typeof value.appID === 'number' &&
      typeof value.storefront === 'string'
    );
  }

  function isCatalogSection(value: unknown): value is CatalogSection {
    if (!isRecord(value)) return false;
    return (
      typeof value.name === 'string' &&
      typeof value.description === 'string' &&
      Array.isArray(value.listings) &&
      value.listings.every(isBasicLibraryInfo)
    );
  }

  function isCatalogCarouselItem(value: unknown): value is CatalogCarouselItem {
    if (!isRecord(value)) return false;
    const hasSupportedImage =
      typeof value.carouselImage === 'string' ||
      typeof value.fullBannerImage === 'string' ||
      typeof value.capsuleImage === 'string';
    return (
      typeof value.name === 'string' &&
      typeof value.description === 'string' &&
      hasSupportedImage
    );
  }

  function normalizeCatalog(catalogData: CatalogResponse): {
    sections: Record<string, CatalogSection>;
    carouselItems: CatalogCarouselItem[];
  } {
    const payload = isRecord(catalogData) ? catalogData : {};
    const sectionsSource =
      'sections' in payload && isRecord(payload.sections)
        ? payload.sections
        : payload;

    const sections: Record<string, CatalogSection> = {};
    Object.entries(sectionsSource).forEach(([sectionId, sectionValue]) => {
      if (isCatalogSection(sectionValue)) {
        sections[sectionId] = sectionValue;
      }
    });

    let carouselItems: CatalogCarouselItem[] = [];
    if ('carousel' in payload) {
      const carousel = payload.carousel;
      if (Array.isArray(carousel)) {
        carouselItems = carousel.filter(isCatalogCarouselItem);
      } else if (isRecord(carousel)) {
        if (isCatalogCarouselItem(carousel)) {
          carouselItems = [carousel];
        } else {
          carouselItems = Object.values(carousel).filter(isCatalogCarouselItem);
        }
      }
    }

    return { sections, carouselItems };
  }

  function getFeaturedImage(item: CatalogCarouselItem) {
    return (
      item.fullBannerImage ??
      item.carouselImage ??
      item.capsuleImage ??
      './favicon.png'
    );
  }

  function handleCarouselNav(
    sectionKey: string,
    direction: number,
    maxPage: number
  ) {
    const currentIndex = carouselIndices[sectionKey] || 0;
    const nextIndex = Math.max(0, Math.min(currentIndex + direction, maxPage));
    if (nextIndex === currentIndex) return;

    carouselIndices = {
      ...carouselIndices,
      [sectionKey]: nextIndex,
    };
  }

  function getCarouselPages(
    listings: BasicLibraryInfo[]
  ): BasicLibraryInfo[][] {
    const pages: BasicLibraryInfo[][] = [];
    for (let start = 0; start < listings.length; start += CAROUSEL_PAGE_SIZE) {
      pages.push(listings.slice(start, start + CAROUSEL_PAGE_SIZE));
    }
    return pages;
  }

  function getCarouselMaxPage(totalItems: number) {
    return Math.max(0, Math.ceil(totalItems / CAROUSEL_PAGE_SIZE) - 1);
  }

  function setFeaturedCarouselIndex(index: number) {
    const count = featuredCarouselItems.length;
    if (count === 0) return;
    featuredCarouselIndex = (index + count) % count;
  }

  function handleFeaturedCarouselNav(direction: number) {
    const count = featuredCarouselItems.length;
    if (count < 2) return;
    setFeaturedCarouselIndex(featuredCarouselIndex + direction + count);
  }

  function goToFeaturedCarouselIndex(index: number) {
    if (index === featuredCarouselIndex) return;
    setFeaturedCarouselIndex(index);
  }

  function shouldPrioritizeFeaturedImage(slideIndex: number) {
    const count = featuredCarouselItems.length;
    if (count <= 1) return true;
    const distance = Math.abs(slideIndex - featuredCarouselIndex);
    return distance <= 1 || distance >= count - 1;
  }

  function shouldPrioritizeSectionPage(
    sectionKey: string,
    pageIndex: number,
    pageCount: number
  ) {
    const activePage = carouselIndices[sectionKey] || 0;
    return pageCount <= 2 || Math.abs(pageIndex - activePage) <= 1;
  }

  function openGameStorePage(game: BasicLibraryInfo) {
    currentStorePageOpened.set(game.appID);
    currentStorePageOpenedStorefront.set(game.storefront);
    viewOpenedWhenChanged.set($selectedView);
  }

  function openFeaturedCarouselItem(item: DiscoverCarouselItem) {
    if (typeof item.appID !== 'number' || typeof item.storefront !== 'string') {
      return;
    }

    openGameStorePage({
      appID: item.appID,
      storefront: item.storefront,
      name: item.name,
      capsuleImage:
        item.capsuleImage ??
        item.carouselImage ??
        item.fullBannerImage ??
        './favicon.png',
    });
  }

  async function loadCatalogs() {
    try {
      loading = true;
      addons = await safeFetch('getAllAddons', {});

      const catalogPromises = addons.map(async (addon) => {
        try {
          const catalogData: CatalogResponse = await safeFetch('getCatalogs', {
            addonID: addon.id,
          });
          const normalizedCatalog = normalizeCatalog(catalogData);

          return {
            addonId: addon.id,
            addonName: addon.name,
            sections: normalizedCatalog.sections,
            carouselItems: normalizedCatalog.carouselItems,
          };
        } catch (error) {
          console.warn(`Failed to load catalog for addon ${addon.id}:`, error);
          return null;
        }
      });

      const results = await Promise.all(catalogPromises);
      catalogs = results.filter(
        (catalog): catalog is AddonCatalog =>
          catalog !== null &&
          (Object.keys(catalog.sections).length > 0 ||
            catalog.carouselItems.length > 0)
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

  $effect(() => {
    const sections: AllSections[] = [];
    catalogs.forEach((catalog) => {
      Object.entries(catalog.sections).forEach(([sectionId, section]) => {
        sections.push({
          sectionId,
          sectionKey: `${catalog.addonId}:${sectionId}`,
          addonId: catalog.addonId,
          addonName: catalog.addonName,
          section,
        });
      });
    });
    allSections = sections;
  });

  $effect(() => {
    const featuredItems: DiscoverCarouselItem[] = [];
    catalogs.forEach((catalog) => {
      catalog.carouselItems.forEach((carouselItem) => {
        featuredItems.push({
          ...carouselItem,
          addonId: catalog.addonId,
          addonName: catalog.addonName,
        });
      });
    });
    featuredCarouselItems = featuredItems;
    if (featuredCarouselIndex >= featuredItems.length) {
      featuredCarouselIndex = 0;
    }
  });

  $effect(() => {
    const count = featuredCarouselItems.length;
    if (count < 2) return;

    const interval = setInterval(() => {
      handleFeaturedCarouselNav(1);
    }, 7000);

    return () => clearInterval(interval);
  });

  $effect(() => {
    const indices: Record<string, number> = {};
    allSections.forEach((section) => {
      indices[section.sectionKey] = 0;
    });
    carouselIndices = indices;
  });

  onMount(() => {
    loadCatalogs();
  });
</script>

<div class="flex flex-col w-full h-full overflow-y-auto gap-6 pb-8">
  {#if loading}
    <!-- Skeleton Loading State -->
    <div class="space-y-6">
      <!-- Skeleton Featured Carousel -->
      <div class="px-4">
        <div
          class="relative overflow-hidden rounded-xl bg-accent-lighter h-52 sm:h-60 md:h-72"
        >
          <div class="absolute inset-0 skeleton"></div>
          <div
            class="absolute inset-0 py-8 px-16 flex flex-col justify-end pointer-events-none"
            style="background: linear-gradient(to top, rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0.12));"
          >
            <div class="flex items-center gap-2 mb-3">
              <div class="skeleton w-6 h-6 rounded"></div>
              <div class="skeleton h-3 w-28"></div>
            </div>
            <div class="skeleton h-8 w-72 mb-2"></div>
            <div class="skeleton h-4 w-104 max-w-full mb-1"></div>
            <div class="skeleton h-4 w-72 max-w-full mb-4"></div>
            <div class="skeleton h-8 w-28 rounded-md"></div>
          </div>
          <div
            class="absolute left-3 top-1/2 -translate-y-1/2 skeleton w-8 h-8 rounded-full"
          ></div>
          <div
            class="absolute right-3 top-1/2 -translate-y-1/2 skeleton w-8 h-8 rounded-full"
          ></div>
          <div
            class="absolute right-4 bottom-4 z-10 flex items-center gap-2 px-3 py-2 rounded-full bg-black/30"
          >
            {#each [1, 2, 3] as _}
              <div
                class="skeleton w-2.5 h-2.5 rounded-full"
                aria-hidden="true"
              ></div>
            {/each}
          </div>
        </div>
      </div>

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
  {:else if allSections.length === 0 && featuredCarouselItems.length === 0}
    <div class="flex flex-col gap-4 w-full justify-center items-center py-16">
      <img src="./favicon.png" alt="content" class="w-24 h-24 opacity-50" />
      <div class="text-center">
        <h2 class="text-xl text-text-secondary mb-2">No catalogs available</h2>
        <p class="text-text-muted">
          Install addons that support catalog browsing to see game collections
        </p>
      </div>
    </div>
  {:else}
    <!-- Catalog Content -->
    <div class="space-y-6">
      {#if featuredCarouselItems.length > 0}
        <div
          class="relative overflow-hidden rounded-xl bg-accent-lighter h-52 sm:h-60 md:h-72"
        >
          <div
            class="featured-carousel-track"
            style={`--featured-index: ${featuredCarouselIndex};`}
          >
            {#each featuredCarouselItems as item, index (`featured-${item.addonId}-${item.appID ?? index}`)}
              {@const isActive = index === featuredCarouselIndex}
              {@const canOpenFeaturedItem =
                typeof item.appID === 'number' &&
                typeof item.storefront === 'string'}
              <div
                class={`featured-carousel-slide ${isActive ? 'is-active' : ''}`}
                aria-hidden={!isActive}
              >
                <img
                  src={getFeaturedImage(item)}
                  alt={item.name}
                  class="w-full h-full object-cover"
                  loading={shouldPrioritizeFeaturedImage(index)
                    ? 'eager'
                    : 'lazy'}
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
                  class="featured-carousel-overlay absolute inset-0 py-8 px-16 flex flex-col justify-end"
                  style="background: linear-gradient(to top, rgba(0, 0, 0, 0.85), rgba(0, 0, 0, 0.15));"
                >
                  <div class="flex items-center gap-2 mb-2">
                    <div class="w-6 h-6 rounded overflow-hidden">
                      <AddonPicture addonId={item.addonId} class="rounded" />
                    </div>
                    <p class="text-white/90 text-xs uppercase tracking-wide">
                      {item.addonName}
                    </p>
                  </div>
                  <h2
                    class="text-white text-2xl md:text-3xl font-semibold mb-1"
                  >
                    {item.name}
                  </h2>
                  <p
                    class="text-white/90 text-sm md:text-base line-clamp-2 max-w-3xl"
                  >
                    {item.description}
                  </p>
                  {#if canOpenFeaturedItem}
                    <button
                      class="mt-4 w-fit bg-white/95 hover:bg-white text-black text-sm font-medium px-3 py-1.5 rounded-md border-none transition-colors"
                      tabindex={isActive ? 0 : -1}
                      onclick={() => openFeaturedCarouselItem(item)}
                    >
                      View Store Page
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          {#if featuredCarouselItems.length > 1}
            <button
              class="absolute left-3 top-1/2 -translate-y-1/2 z-10 bg-black/45 hover:bg-black/65 text-white rounded-full w-8 h-8 flex items-center justify-center transition-colors border-none"
              onclick={() => handleFeaturedCarouselNav(-1)}
              aria-label="Previous featured game"
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
            <button
              class="absolute right-3 top-1/2 -translate-y-1/2 z-10 bg-black/45 hover:bg-black/65 text-white rounded-full w-8 h-8 flex items-center justify-center transition-colors border-none"
              onclick={() => handleFeaturedCarouselNav(1)}
              aria-label="Next featured game"
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
            <div
              class="absolute right-4 bottom-4 z-10 flex items-center gap-2 px-3 py-2 rounded-full bg-black/45 backdrop-blur-sm"
            >
              {#each featuredCarouselItems as _, index (`featured-${index}`)}
                <button
                  class={`w-2.5 h-2.5 rounded-full border-none transition-colors ${
                    index === featuredCarouselIndex ? 'bg-white' : 'bg-white/45'
                  }`}
                  onclick={() => goToFeaturedCarouselIndex(index)}
                  aria-label={`Go to featured item ${index + 1}`}
                ></button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#each allSections as sectionItem (sectionItem.sectionKey)}
        <div class="space-y-3">
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
            {@const sectionPages = getCarouselPages(
              sectionItem.section.listings
            )}
            {@const currentPage = carouselIndices[sectionItem.sectionKey] || 0}
            {@const maxPage = getCarouselMaxPage(
              sectionItem.section.listings.length
            )}
            <div class="relative flex items-center w-full">
              <!-- Left Arrow -->
              <button
                class="absolute left-0 z-10 bg-accent-lighter hover:bg-accent-light text-accent-dark rounded-full w-8 h-8 flex items-center justify-center shadow transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-none"
                style="top: 50%; transform: translateY(-50%);"
                onclick={() =>
                  handleCarouselNav(sectionItem.sectionKey, -1, maxPage)}
                disabled={currentPage === 0}
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
              <div class="discover-games-carousel-window">
                <div
                  class="discover-games-carousel-track"
                  style={`--carousel-index: ${currentPage};`}
                >
                  {#each sectionPages as page, pageIndex (`${sectionItem.sectionKey}-page-${pageIndex}`)}
                    {@const prioritizePage = shouldPrioritizeSectionPage(
                      sectionItem.sectionKey,
                      pageIndex,
                      sectionPages.length
                    )}
                    <div
                      class="discover-games-carousel-page"
                      aria-hidden={pageIndex !== currentPage}
                    >
                      {#each page as game (game.appID)}
                        <button
                          class="discover-game-card group w-32 h-48 relative border-none transition-all duration-200 shadow-md hover:shadow-lg rounded-lg overflow-hidden bg-surface transform hover:scale-102 hover:-translate-y-0.5"
                          onclick={() => openGameStorePage(game)}
                          aria-label={game.name}
                          tabindex={pageIndex === currentPage ? 0 : -1}
                        >
                          <div class="relative">
                            <img
                              src={game.capsuleImage}
                              alt={game.name}
                              class="w-32 h-48 object-cover"
                              loading={prioritizePage ? 'eager' : 'lazy'}
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
                              class="absolute inset-x-0 bottom-0 p-1.5"
                              style="background: linear-gradient(to top, var(--color-overlay-bg), transparent);"
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
              </div>

              <!-- Right Arrow -->
              <button
                class="absolute right-0 z-10 bg-accent-lighter hover:bg-accent-light text-accent-dark rounded-full w-8 h-8 flex items-center justify-center shadow transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-none"
                style="top: 50%; transform: translateY(-50%);"
                onclick={() =>
                  handleCarouselNav(sectionItem.sectionKey, 1, maxPage)}
                disabled={currentPage >= maxPage}
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
            <div class="text-center py-6 text-text-muted">
              <p class="text-sm">No games in this collection</p>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .featured-carousel-track {
    display: flex;
    height: 100%;
    transform: translate3d(calc(var(--featured-index, 0) * -100%), 0, 0);
    transition: transform 460ms cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
  }

  .featured-carousel-slide {
    position: relative;
    flex: 0 0 100%;
    height: 100%;
  }

  .featured-carousel-slide:not(.is-active) {
    pointer-events: none;
  }

  .discover-games-carousel-window {
    min-height: 200px;
    overflow: hidden;
    width: 100%;
    padding: 0 clamp(3rem, 6vw, 4.25rem);
  }

  .discover-games-carousel-track {
    display: flex;
    transform: translate3d(calc(var(--carousel-index, 0) * -100%), 0, 0);
    transition: transform 360ms cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
  }

  .discover-games-carousel-page {
    flex: 0 0 100%;
    display: flex;
    justify-content: center;
    gap: 0.75rem;
  }

  .discover-game-card:hover {
    box-shadow:
      0 20px 40px 0 rgba(0, 0, 0, 0.15),
      0 4px 10px 0 rgba(0, 0, 0, 0.1);
  }
</style>
