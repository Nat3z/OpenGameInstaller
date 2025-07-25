<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import ConfigView from './views/ConfigView.svelte';
  import ClientOptionsView from './views/ClientOptionsView.svelte';
  import DownloadView from './views/DownloadView.svelte';
  import DownloadManager from './managers/DownloadManager.svelte';
  import OOBE from './views/OutOfBoxExperience.svelte';

  import {
    fetchAddonsWithConfigure,
    getConfigClientOption,
    safeFetch,
  } from './utils';
  import Notifications from './managers/NotificationManager.svelte';
  import NotificationSideView from './components/NotificationSideView.svelte';
  import {
    addonUpdates,
    currentStorePageOpened,
    currentStorePageOpenedStorefront,
    selectedView,
    viewOpenedWhenChanged,
    type Views,
    searchResults as searchResultsStore,
    searchQuery,
    loadingResults,
    isOnline,
    createNotification,
    fetchCommunityAddons,
    notifications,
    showNotificationSideView,
  } from './store';
  import StorePage from './components/StorePage.svelte';
  import ConfigurationModal from './components/modal/ConfigurationModal.svelte';
  import LibraryView from './views/LibraryView.svelte';
  import GameManager from './managers/GameManager.svelte';
  import type { BasicLibraryInfo, OGIAddonConfiguration } from 'ogi-addon';
  import type { ConfigurationFile } from 'ogi-addon/config';
  import Debug from './managers/Debug.svelte';
  import DiscoverView from './views/DiscoverView.svelte';

  interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
    configTemplate: ConfigurationFile;
  }

  // post config to server for each addon

  let finishedOOBE = $state(true);
  let loading = $state(true);
  let addons: ConfigTemplateAndInfo[] = $state([]);
  let showSearchResults = $state(false);
  let searchTimeout: NodeJS.Timeout | null = null;

  let recentlyLaunchedApps: LibraryInfo[] = $state([]);

  onMount(() => {
    // Initialize notification side view state
    console.log('App mounted, initializing stores');
    showNotificationSideView.set(false);
    loading = true;
    setTimeout(() => {
      fetchAddonsWithConfigure();
      const installedOption = getConfigClientOption('installed') as {
        installed: boolean;
      };
      if (!installedOption || !installedOption.installed) {
        finishedOOBE = false;
      }
      loading = false;

      // get recently launched apps
      updateRecents();

      // Initialize search-related data
      initializeSearch();
    }, 100);
  });

  async function initializeSearch() {
    try {
      const addonData = await safeFetch('getAllAddons', {});
      addons = addonData;

      const online = await window.electronAPI.app.isOnline();
      isOnline.set(online);
    } catch (error) {
      console.error('Failed to initialize search:', error);
    }
  }

  async function performSearch(query: string) {
    if (!$isOnline || !query.trim()) {
      showSearchResults = false;
      return;
    }

    try {
      loadingResults.set(true);
      showSearchResults = true;
      addons = await fetchAddonsWithConfigure();
      searchResultsStore.set([]);

      // Search through addons first
      let promises: Promise<void>[] = [];
      for (const addon of addons) {
        promises.push(
          safeFetch(
            'searchQuery',
            {
              addonID: addon.id,
              query: query,
            },
            { consume: 'json' }
          ).then((response: BasicLibraryInfo[]) => {
            console.log(response);
            searchResultsStore.update((value) => [...value, ...response]);
          })
        );
      }
      await Promise.allSettled(promises);
      loadingResults.set(false);
    } catch (ex) {
      console.error(ex);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Failed to fetch search results',
        type: 'error',
      });
      loadingResults.set(false);
    }
  }

  function handleSearchInput(event: Event) {
    const target = event.target as HTMLInputElement;
    const query = target.value;
    searchQuery.set(query);

    // Clear existing timeout
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    if (query.trim()) {
      // Debounce search by 500ms to prevent rapid API calls
      searchTimeout = setTimeout(() => {
        performSearch(query);
      }, 500);
    } else {
      searchResultsStore.set([]);
      showSearchResults = false;
    }
  }

  function goToListing(appID: number, storefront: string) {
    if (!$isOnline) return;
    currentStorePageOpened.set(appID);
    currentStorePageOpenedStorefront.set(storefront);
    viewOpenedWhenChanged.set($selectedView);
    showSearchResults = false;
  }

  function updateRecents() {
    let exists = window.electronAPI.fs.exists('./internals/apps.json');
    let itemsAdded = 0;
    if (exists) {
      let apps: number[] = JSON.parse(
        window.electronAPI.fs.read('./internals/apps.json')
      );
      // then get the app info via the ./library/{appID}.json
      recentlyLaunchedApps = [];
      apps.forEach((appID) => {
        let exists = window.electronAPI.fs.exists(`./library/${appID}.json`);
        if (itemsAdded >= 3) return;
        if (exists) {
          let appInfo: LibraryInfo = JSON.parse(
            window.electronAPI.fs.read(`./library/${appID}.json`)
          );
          recentlyLaunchedApps.push(appInfo);
          itemsAdded++;
        }
      });
    }
  }

  let heldPageOpened: number | undefined;
  let isStoreOpen = false;
  let iTriggeredIt = false;

  document.addEventListener('addon:update-available', (event) => {
    if (event instanceof CustomEvent) {
      const { detail } = event;
      addonUpdates.update((value) => {
        value.push(detail);
        return value;
      });
    }
  });
  document.addEventListener('addon:updated', (event) => {
    if (event instanceof CustomEvent) {
      const { detail } = event;
      addonUpdates.update((value) => {
        value = value.filter((addon) => addon !== detail);
        return value;
      });
    }
  });
  currentStorePageOpened.subscribe((value) => {
    if (value) {
      heldPageOpened = value;
      isStoreOpen = true;
      if (!$viewOpenedWhenChanged && !iTriggeredIt)
        viewOpenedWhenChanged.set($selectedView);
    }
  });
  let exitPlayPage: () => void = $state(() => {});
  function setView(view: Views) {
    iTriggeredIt = true;
    showSearchResults = false;
    searchQuery.set('');
    searchResultsStore.set([]);

    if (isStoreOpen && $selectedView === view) {
      // If the store is open and the same tab is clicked again, close the store
      isStoreOpen = false;
      currentStorePageOpened.set(undefined);
      heldPageOpened = undefined;
      viewOpenedWhenChanged.set(undefined);
      console.log('Removing store from view');
    } else if (
      view === $viewOpenedWhenChanged &&
      heldPageOpened !== undefined
    ) {
      // If switching back to the tab that had the store, reopen the store
      currentStorePageOpened.set(heldPageOpened);
      selectedView.set(view);
      isStoreOpen = true;
      console.log('Switching back to tab that had the store');
    } else {
      // Otherwise, just switch to the new tab
      if ($selectedView === view && view === 'library') {
        exitPlayPage();
      } else {
        selectedView.set(view);
        currentStorePageOpened.set(undefined);
        isStoreOpen = false;
        console.log('Otherwise, just switch to the new tab');
      }
    }
    iTriggeredIt = false;
  }
  setTimeout(() => {
    fetchCommunityAddons();
  }, 2000);

  function toggleNotificationSideView() {
    showNotificationSideView.update((v) => {
      return !v;
    });
  }
</script>

<Notifications />
{#if !finishedOOBE}
  <OOBE finishedSetup={() => (finishedOOBE = true)} />
{/if}

{#if !loading}
  <div class="flex flex-col h-screen w-screen fixed left-0 top-0">
    <!-- Top Header -->
    <header
      class="flex items-center justify-start w-full h-24 px-2 bg-background-color"
    >
      <!-- Left side - Avatar/Logo -->
      <div class="flex items-center justify-center h-24 w-24">
        <img
          src="./favicon.png"
          alt="avatar"
          class="avatar rounded-full object-cover mx-auto my-auto transition-transform duration-300 hover:scale-110"
        />
      </div>

      <!-- Center - Search Bar -->
      <div class="flex-1 max-w-2xl mx-8">
        <div class="relative h-full">
          <svg
            class="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-accent-dark transition-colors duration-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="m21 21-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            ></path>
          </svg>
          <input
            type="text"
            placeholder={$isOnline
              ? 'Search for games...'
              : 'Search unavailable (offline)'}
            disabled={!$isOnline}
            class="w-full h-[var(--header-button-size)] pl-12 pr-4 text-lg bg-accent-lighter rounded-lg border-none focus:outline-none font-archivo placeholder-accent-dark disabled:opacity-50 transition-all duration-300 ease-out focus:bg-white focus:shadow-md"
            value={$searchQuery}
            oninput={handleSearchInput}
          />
        </div>
      </div>

      <!-- Right side - Action buttons -->
      <div class="flex items-center gap-4 -left-2 relative">
        <!-- Download button -->
        <button
          class="header-button"
          onclick={() => {
            setView('downloader');
          }}
          aria-label="Downloads"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 50 50"
            fill="none"
            class="fill-accent-dark"
          >
            <g clip-path="url(#clip0_2_123)">
              <path
                d="M34.5625 18.75H31.25V8.33333C31.25 7.1875 30.3125 6.25 29.1666 6.25H20.8333C19.6875 6.25 18.75 7.1875 18.75 8.33333V18.75H15.4375C13.5833 18.75 12.6458 21 13.9583 22.3125L23.5208 31.875C24.3333 32.6875 25.6458 32.6875 26.4583 31.875L36.0208 22.3125C37.3333 21 36.4166 18.75 34.5625 18.75ZM10.4166 39.5833C10.4166 40.7292 11.3541 41.6667 12.5 41.6667H37.5C38.6458 41.6667 39.5833 40.7292 39.5833 39.5833C39.5833 38.4375 38.6458 37.5 37.5 37.5H12.5C11.3541 37.5 10.4166 38.4375 10.4166 39.5833Z"
                fill="#2D626A"
              />
            </g>
            <defs>
              <clipPath id="clip0_2_123">
                <rect width="50" height="50" fill="white" />
              </clipPath>
            </defs>
          </svg>
        </button>

        <!-- Notification button -->
        <button
          class="header-button relative"
          aria-label="Notifications"
          onclick={toggleNotificationSideView}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 50 50"
            fill="none"
            class="fill-accent-dark"
          >
            <g clip-path="url(#clip0_22_1842)">
              <path
                d="M25 45.8333C27.2917 45.8333 29.1667 43.9583 29.1667 41.6666H20.8333C20.8333 43.9583 22.6875 45.8333 25 45.8333ZM37.5 33.3333V22.9166C37.5 16.5208 34.0833 11.1666 28.125 9.74998V8.33331C28.125 6.60415 26.7292 5.20831 25 5.20831C23.2708 5.20831 21.875 6.60415 21.875 8.33331V9.74998C15.8958 11.1666 12.5 16.5 12.5 22.9166V33.3333L9.81249 36.0208C8.49999 37.3333 9.41665 39.5833 11.2708 39.5833H38.7083C40.5625 39.5833 41.5 37.3333 40.1875 36.0208L37.5 33.3333Z"
                fill="#2D626A"
              />
            </g>
            <defs>
              <clipPath id="clip0_22_1842">
                <rect width="50" height="50" fill="white" />
              </clipPath>
            </defs>
          </svg>
          {#if $notifications.length > 0}
            <div
              class="absolute -bottom-1 -right-1 bg-accent-dark text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold"
            >
              {$notifications.length}
            </div>
          {/if}
        </button>
      </div>
    </header>

    <div class="flex flex-1 pl-4 overflow-hidden">
      <!-- Left Sidebar -->
      <nav
        class="flex flex-col items-center w-20 h-full bg-background-color py-4"
      >
        <!-- Navigation buttons -->
        <div class="flex flex-col gap-4">
          <button
            onclick={() => setView('library')}
            data-selected-header={$selectedView === 'library'}
            aria-label="Library"
            class="nav-button"
          >
            <svg
              viewBox="0 0 60 60"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
            >
              <path
                d="M39 15.87V3C39 1.35 37.65 0 36 0H24C22.35 0 21 1.35 21 3V15.87C21 16.26 21.15 16.65 21.45 16.92L28.95 24.42C29.55 25.02 30.48 25.02 31.08 24.42L38.58 16.92C38.85 16.65 39 16.29 39 15.87ZM15.87 21H3C1.35 21 0 22.35 0 24V36C0 37.65 1.35 39 3 39H15.87C16.26 39 16.65 38.85 16.92 38.55L24.42 31.05C25.02 30.45 25.02 29.52 24.42 28.92L16.92 21.42C16.65 21.15 16.29 21 15.87 21ZM21 44.13V57C21 58.65 22.35 60 24 60H36C37.65 60 39 58.65 39 57V44.13C39 43.74 38.85 43.35 38.55 43.08L31.05 35.58C30.45 34.98 29.52 34.98 28.92 35.58L21.42 43.08C21.15 43.35 21 43.71 21 44.13ZM43.05 21.45L35.55 28.95C34.95 29.55 34.95 30.48 35.55 31.08L43.05 38.58C43.32 38.85 43.71 39.03 44.1 39.03H57C58.65 39.03 60 37.68 60 36.03V24.03C60 22.38 58.65 21.03 57 21.03H44.13C43.71 21 43.35 21.15 43.05 21.45Z"
                fill="currentColor"
              />
            </svg>
          </button>

          <button
            onclick={() => setView('discovery')}
            data-selected-header={$selectedView === 'discovery'}
            aria-label="Discovery"
            class="nav-button"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="currentColor"
              height="24"
              viewBox="0 0 24 24"
              width="24"
              ><path d="M0 0h24v24H0V0z" fill="none" /><path
                d="M12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1c.61 0 1.1-.49 1.1-1.1s-.49-1.1-1.1-1.1zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm2.19 12.19L6 18l3.81-8.19L18 6l-3.81 8.19z"
              /></svg
            >
          </button>

          <button
            onclick={() => setView('config')}
            data-selected-header={$selectedView === 'config'}
            aria-label="Addon Settings"
            class="nav-button"
          >
            <svg
              viewBox="0 0 60 60"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
            >
              <g clip-path="url(#clip0_2_52)">
                <path
                  d="M51.25 27.5H47.5V17.5C47.5 14.75 45.25 12.5 42.5 12.5H32.5V8.75C32.5 5.3 29.7 2.5 26.25 2.5C22.8 2.5 20 5.3 20 8.75V12.5H10C7.25 12.5 5.025 14.75 5.025 17.5V27H8.75C12.475 27 15.5 30.025 15.5 33.75C15.5 37.475 12.475 40.5 8.75 40.5H5V50C5 52.75 7.25 55 10 55H19.5V51.25C19.5 47.525 22.525 44.5 26.25 44.5C29.975 44.5 33 47.525 33 51.25V55H42.5C45.25 55 47.5 52.75 47.5 50V40H51.25C54.7 40 57.5 37.2 57.5 33.75C57.5 30.3 54.7 27.5 51.25 27.5Z"
                  fill="currentColor"
                />
              </g>
              <defs>
                <clipPath id="clip0_2_52">
                  <rect width="60" height="60" fill="white" />
                </clipPath>
              </defs>
            </svg>
          </button>

          <button
            onclick={() => setView('clientoptions')}
            data-selected-header={$selectedView === 'clientoptions'}
            aria-label="Client Options"
            class="nav-button"
          >
            <svg
              viewBox="0 0 60 60"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
            >
              <g clip-path="url(#clip0_2_25)">
                <path
                  d="M52.4974 30C52.4974 29.3101 52.4674 28.6502 52.4074 27.9602L57.9868 23.7307C59.1867 22.8308 59.5166 21.151 58.7667 19.8311L53.1573 10.1422C52.4074 8.82235 50.7876 8.28241 49.4078 8.88234L42.9585 11.612C41.8486 10.8321 40.6787 10.1422 39.4489 9.57227L38.579 2.64303C38.399 1.1432 37.1091 0.00332642 35.6093 0.00332642H24.4205C22.8907 0.00332642 21.6008 1.1432 21.4209 2.64303L20.551 9.57227C19.3211 10.1422 18.1512 10.8321 17.0414 11.612L10.5921 8.88234C9.21222 8.28241 7.5924 8.82235 6.84248 10.1422L1.2331 19.8611C0.483185 21.181 0.813148 22.8308 2.01302 23.7607L7.5924 27.9902C7.5324 28.6502 7.50241 29.3101 7.50241 30C7.50241 30.6899 7.5324 31.3499 7.5924 32.0398L2.01302 36.2693C0.813148 37.1692 0.483185 38.849 1.2331 40.1689L6.84248 49.8578C7.5924 51.1777 9.21222 51.7176 10.5921 51.1177L17.0414 48.388C18.1512 49.1679 19.3211 49.8578 20.551 50.4277L21.4209 57.357C21.6008 58.8568 22.8907 59.9967 24.3905 59.9967H35.5793C37.0791 59.9967 38.369 58.8568 38.549 57.357L39.4189 50.4277C40.6487 49.8578 41.8186 49.1679 42.9285 48.388L49.3778 51.1177C50.7576 51.7176 52.3774 51.1777 53.1273 49.8578L58.7367 40.1689C59.4866 38.849 59.1567 37.1992 57.9568 36.2693L52.3774 32.0398C52.4674 31.3499 52.4974 30.6899 52.4974 30ZM30.1199 40.4988C24.3305 40.4988 19.6211 35.7894 19.6211 30C19.6211 24.2106 24.3305 19.5012 30.1199 19.5012C35.9093 19.5012 40.6187 24.2106 40.6187 30C40.6187 35.7894 35.9093 40.4988 30.1199 40.4988Z"
                  fill="currentColor"
                />
              </g>
              <defs>
                <clipPath id="clip0_2_25">
                  <rect width="60" height="60" fill="white" />
                </clipPath>
              </defs>
            </svg>
          </button>
        </div>
      </nav>

      <!-- Main Content Area -->
      <main
        class="flex-1 overflow-y-auto left-10 top-4 max-w-[51.5rem] relative mb-10"
      >
        <!-- Content Container with absolute positioning for animations -->
        <div class="content-container overflow-x-hidden">
          {#if showSearchResults}
            <!-- Search Results View -->
            <div
              class="content-view search-results-container"
              in:fly={{ y: 20, duration: 300, easing: quintOut }}
              out:fly={{ y: -20, duration: 200 }}
            >
              <div class="search-info mb-6 flex flex-row gap-8 items-center">
                {#if $loadingResults}
                  <div
                    class="relative"
                    in:fade={{ duration: 300 }}
                    out:fade={{ duration: 300 }}
                  >
                    <div class="loading-spinner"></div>
                  </div>
                {/if}
                <div class="flex flex-col gap-2">
                  <h2 class="text-2xl font-archivo font-bold mb-2">
                    Search Results
                  </h2>
                  <p class="text-gray-600">
                    Results for: <span class="font-semibold"
                      >"{$searchQuery}"</span
                    >
                  </p>
                </div>
              </div>

              {#if !$isOnline}
                <div
                  class="flex flex-col gap-4 w-full justify-center items-center h-96"
                >
                  <img
                    src="./favicon.png"
                    alt="offline"
                    class="w-32 h-32 opacity-50"
                  />
                  <h3 class="text-xl text-gray-700">You're Offline</h3>
                  <p class="text-gray-500 text-center">
                    Searching for games is unavailable when you're offline.
                  </p>
                </div>
              {:else}
                {#if addons.length === 0}
                  <div class="no-addons-message" in:fade={{ duration: 300 }}>
                    <h3
                      class="text-xl font-bold mb-2 text-accent-dark font-archivo"
                    >
                      No Addons Installed
                    </h3>
                    <p class="text-accent-dark font-archivo mx-8">
                      You can still view store pages, but won't be able to
                      download/install your games.
                    </p>
                    <button
                      class="border-none bg-accent-light mt-4 hover:bg-accent-light/75 transition-colors text-accent-dark font-archivo font-semibold px-4 py-2 rounded-lg"
                      onclick={() => setView('config')}
                    >
                      Get Addons
                    </button>
                  </div>
                {/if}
                <div class="search-results">
                  {#each $searchResultsStore as result, index}
                    <div
                      class="search-result-item"
                      in:fly={{ y: 30, duration: 400, delay: 50 * index }}
                    >
                      <img
                        src={result.capsuleImage}
                        alt={result.name}
                        class="result-image"
                      />
                      <div class="result-content">
                        <h3 class="result-title">{result.name}</h3>
                        <p class="result-source">
                          Storefront: {result.storefront}
                        </p>
                        <button
                          class="result-button"
                          onclick={() =>
                            goToListing(result.appID, result.storefront)}
                        >
                          View Details
                        </button>
                      </div>
                    </div>
                  {/each}

                  {#if $searchResultsStore.length === 0 && !$loadingResults}
                    <div class="no-results" in:fade={{ duration: 300 }}>
                      <h3 class="text-xl text-gray-700 mb-2">
                        No Results Found
                      </h3>
                      <p class="text-gray-500">
                        Try searching for a different game
                      </p>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {:else if $currentStorePageOpened}
            <div
              class="content-view"
              in:fly={{ x: 100, duration: 400, easing: quintOut }}
              out:fly={{ x: -100, duration: 300 }}
            >
              <StorePage
                appID={$currentStorePageOpened}
                storefront={$currentStorePageOpenedStorefront || 'steam'}
              />
            </div>
          {:else if $selectedView === 'config'}
            <div
              class="content-view"
              in:fly={{ x: 100, duration: 400, easing: quintOut }}
              out:fly={{ x: -100, duration: 300 }}
            >
              <ConfigView />
            </div>
          {:else if $selectedView === 'clientoptions'}
            <div
              class="content-view"
              in:fly={{ x: 100, duration: 400, easing: quintOut }}
              out:fly={{ x: -100, duration: 300 }}
            >
              <ClientOptionsView />
            </div>
          {:else if $selectedView === 'downloader'}
            <div
              class="content-view"
              in:fly={{ y: -100, duration: 400, easing: quintOut }}
              out:fly={{ y: 100, duration: 300 }}
            >
              <DownloadView />
            </div>
          {:else if $selectedView === 'library'}
            <div
              class="content-view"
              in:fly={{ x: 100, duration: 400, easing: quintOut }}
              out:fly={{ x: -100, duration: 300 }}
            >
              <LibraryView bind:exitPlayPage />
            </div>
          {:else if $selectedView === 'discovery'}
            <div
              class="content-view"
              in:fly={{ x: 100, duration: 400, easing: quintOut }}
              out:fly={{ x: -100, duration: 300 }}
            >
              <DiscoverView />
            </div>
          {:else}
            <div
              class="content-view"
              in:fly={{ x: 100, duration: 400, easing: quintOut }}
              out:fly={{ x: -100, duration: 300 }}
            >
              <LibraryView bind:exitPlayPage />
            </div>
          {/if}
        </div>
        <!-- Bottom fade gradient overlay -->
        <div
          class="pointer-events-none absolute left-0 bottom-0 w-full h-2 bg-gradient-to-t from-background-color to-transparent"
        ></div>
      </main>
    </div>

    <DownloadManager />
    <ConfigurationModal />
    <GameManager />
    <Debug />
    <NotificationSideView />
  </div>
{/if}

<style global>
  @tailwind base;
  @tailwind components;
  @tailwind utilities;

  :root {
    /* Navigation button sizing */
    --nav-button-size: 4rem;
    --nav-button-svg-size: 3.5rem;

    /* Header button sizing */
    --header-button-size: 3.5rem;
    --header-button-svg-size: 2rem;

    /* Avatar sizing */
    --avatar-size: 5rem;
  }

  * {
    -webkit-touch-callout: none; /* iOS Safari */
    -webkit-user-select: none; /* Safari */
    -moz-user-select: none; /* Old versions of Firefox */
    -ms-user-select: none; /* Internet Explorer/Edge */
    user-select: none; /* Non-prefixed version, currently
																		supported by Chrome, Edge, Opera and Firefox */
  }

  body {
    @apply bg-background-color;
  }

  ::-webkit-scrollbar {
    width: 5px;
  }

  ::-webkit-scrollbar-thumb {
    background-color: #cbcbcb51;
    @apply rounded-lg bg-opacity-10;
  }

  ::-webkit-scrollbar-thumb:hover {
    background-color: #909090;
    @apply rounded-lg bg-opacity-100;
  }

  textarea:focus,
  input[type='text']:focus,
  input[type='password']:focus,
  input[type='number']:focus {
    @apply outline outline-accent-light;
  }

  button {
    @apply font-open-sans;
  }

  .nav-button {
    @apply p-3 rounded-lg border-none hover:bg-gray-100 text-accent-dark transition-all duration-300 ease-out flex justify-center items-center;
    width: var(--nav-button-size);
    height: var(--nav-button-size);
    transform: scale(1);
  }

  .nav-button:hover {
    transform: scale(1.05);
  }

  .nav-button[data-selected-header='true'] {
    @apply bg-accent-lighter text-accent-dark;
    transform: scale(1.1);
  }

  .nav-button svg {
    width: var(--nav-button-svg-size);
    height: var(--nav-button-svg-size);
  }

  .header-button {
    @apply rounded-lg bg-accent-lighter flex justify-center items-center border-none transition-all duration-300 ease-out;
    width: var(--header-button-size);
    height: var(--header-button-size);
    transform: scale(1);
  }

  .header-button:hover {
    @apply bg-accent-light;
    transform: scale(1.05);
  }

  .header-button svg {
    width: var(--header-button-svg-size);
    height: var(--header-button-svg-size);
  }

  .avatar {
    width: var(--avatar-size);
    height: var(--avatar-size);
  }

  .search-info {
    @apply mb-6;
  }

  .search-results {
    @apply flex flex-col gap-4;
  }

  .search-result-item {
    @apply flex gap-4 p-4 bg-white rounded-lg border border-gray-200 hover:shadow-md transition-all duration-300 ease-out;
    transform: translateY(0);
  }

  .search-result-item:hover {
    transform: translateY(-2px);
    @apply shadow-lg;
  }

  .result-image {
    @apply w-24 h-24 rounded object-cover flex-shrink-0;
  }

  .result-content {
    @apply flex-1 flex flex-col gap-2;
  }

  .result-title {
    @apply text-lg font-archivo font-semibold text-gray-900;
  }

  .result-source {
    @apply text-sm text-gray-500 capitalize;
  }

  .result-button {
    @apply self-start px-4 py-2 bg-accent-dark text-white rounded-lg hover:bg-accent transition-colors;
  }

  .no-results {
    @apply flex flex-col items-center justify-center py-12 text-center;
  }

  .no-addons-message {
    @apply flex flex-col items-center justify-center py-12 text-center bg-accent-lighter rounded-lg mb-4;
  }

  .loading-message {
    @apply flex flex-col items-center justify-center py-12 text-center;
  }

  .loading-spinner {
    @apply w-8 h-8 border-4 border-gray-300 border-t-accent-dark rounded-full animate-spin mb-4;
  }

  /* Content Animation Container */
  .content-container {
    @apply relative w-full h-full;
  }

  .content-view {
    @apply absolute inset-0 w-full;
  }
</style>
