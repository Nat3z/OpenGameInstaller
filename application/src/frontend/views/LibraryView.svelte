<script lang="ts">
  import type { LibraryInfo } from 'ogi-addon';
  import { onDestroy, onMount } from 'svelte';
  import PlayPage from '../components/PlayPage.svelte';
  import { gameFocused } from '../store';
  import { writable, type Writable } from 'svelte/store';
  import Image from '../components/Image.svelte';
  import {
    getAllApps,
    getRecentlyPlayed,
    sortLibraryAlphabetically,
    filterLibrary,
    chunkArray,
  } from '../lib/core/library';
  import { updatesManager } from '../states.svelte';
  import UpdateIcon from '../Icons/UpdateIcon.svelte';

  let library: LibraryInfo[] = $state([]);
  let recentlyPlayed: LibraryInfo[] = $state([]);
  let allGamesAlphabetical: LibraryInfo[] = $state([]);
  let filteredGames: LibraryInfo[] = $state([]);
  let selectedApp: Writable<LibraryInfo | undefined> = writable(undefined);
  let loading = $state(true);
  let searchQuery = $state('');

  let { exitPlayPage = $bindable() } = $props();

  // Avoid infinite update loop by only assigning exitPlayPage once on mount
  onMount(() => {
    if (exitPlayPage) {
      exitPlayPage = () => {
        $selectedApp = undefined;
        reloadLibrary();
      };
    }
  });

  async function reloadLibrary() {
    library = await getAllApps();

    // Update recently played (first 4 games from the ordered list)
    recentlyPlayed = getRecentlyPlayed(library);

    // Update all games alphabetical
    allGamesAlphabetical = sortLibraryAlphabetically(library);

    // Update filtered games
    filteredGames = filterLibrary(allGamesAlphabetical, searchQuery);

    loading = false;
  }

  // Update filtered games when search query changes
  $effect(() => {
    filteredGames = filterLibrary(allGamesAlphabetical, searchQuery);
  });

  onMount(async () => {
    await reloadLibrary();
  });

  const unsubscribe = gameFocused.subscribe((game) => {
    if (game !== undefined) {
      setTimeout(() => {
        selectedApp.set(library.find((app) => app.appID === game));
        gameFocused.set(undefined);
      }, 100);
    }
  });

  onDestroy(() => {
    unsubscribe();
  });

  let allGamesChunks = $derived(chunkArray(filteredGames, 5));
</script>

{#key library}
  <div class="relative w-full h-full">
    {#if $selectedApp}
      <PlayPage libraryInfo={$selectedApp} {exitPlayPage} />
    {/if}

    {#await window.electronAPI.app.getOS()}
      <div class="flex justify-center items-center w-full h-full">
        <div
          class="animate-spin rounded-full h-8 w-8 border-b-2 border-border-muted"
        ></div>
      </div>
    {:then os}
      {#if os === 'win32' || os === 'darwin' || os === 'linux'}
        <div class="flex flex-col w-full h-full overflow-y-auto gap-4 pb-8">
          <!-- Recently Played Section -->
          {#if recentlyPlayed.length > 0}
            <div class="space-y-6">
              <div class="bg-accent-lighter px-4 py-2 rounded-lg">
                <h2 class="text-xl font-semibold text-accent-dark">
                  Recently Played
                </h2>
              </div>
              <div class="flex gap-4 flex-row overflow-x-auto">
                {#each recentlyPlayed as app}
                  <button
                    data-library-item
                    class="ml-4 shrink-0 border-none relative transition-all shadow-lg hover:shadow-xl rounded-lg overflow-hidden bg-surface"
                    onclick={() => ($selectedApp = app)}
                  >
                    {#if updatesManager.getAppUpdate(app.appID)?.updateAvailable}
                      <div
                        class="absolute shadow-md top-2 right-2 h-6 z-2 flex items-center bg-accent text-accent-text-color rounded-lg flex-row justify-end gap-1 px-2"
                      >
                        <UpdateIcon fill="currentColor" width="16px" height="16px" />
                        <p class="text-sm font-open-sans font-semibold">
                          Update
                        </p>
                      </div>
                    {/if}
                    <Image
                      src={app.capsuleImage}
                      alt={app.name}
                      classifier={app.appID.toString() + '-capsule'}
                      onerror={(e) => {
                        const fallback = './favicon.png';
                        const img = e.currentTarget as HTMLImageElement;
                        if (img.src !== fallback) {
                          img.src = fallback;
                          img.style.opacity = '0.5';
                          (
                            (img.parentElement as HTMLElement)
                              .children[1]! as HTMLElement
                          ).dataset.backup = 'enabled';
                        }
                      }}
                      class="w-48 h-72 object-cover"
                    />
                    <div
                      data-backup="disabled"
                      class="absolute inset-0 flex items-end justify-center data-[backup=disabled]:hidden"
                    >
                      <div
                        class="absolute inset-x-0 bottom-0 w-full h-1/2 pointer-events-none"
                        style="background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);"
                      ></div>
                      <p
                        class="text-white text-base py-4 text-center font-archivo z-1"
                      >
                        {app.name}
                      </p>
                    </div>
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <!-- All Games Section -->
          <div class="space-y-6">
            <div
              class="bg-accent-lighter px-4 py-2 rounded-lg flex items-center justify-between"
            >
              <h2 class="text-xl font-semibold text-accent-dark">All Games</h2>
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
                  placeholder="Search games..."
                  class="block w-64 pl-9 pr-3 py-2 border border-accent rounded-md text-sm bg-surface placeholder-accent focus:outline-none focus:ring-1 focus:ring-accent-dark focus:border-accent-dark transition-colors"
                />
              </div>
            </div>

            {#if filteredGames.length === 0 && !loading}
              <div
                class="flex flex-col gap-4 w-full justify-center items-center py-16"
              >
                <img
                  src="./favicon.png"
                  alt="content"
                  class="w-24 h-24 opacity-50"
                />
                <div class="text-center">
                  <h1 class="text-xl text-text-muted mb-2">
                    {searchQuery ? 'No games found' : 'No games in library'}
                  </h1>
                  {#if searchQuery}
                    <p class="text-text-muted">Try adjusting your search terms</p>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="space-y-4">
                {#each allGamesChunks as chunk}
                  <div class="flex gap-4 flex-wrap">
                    {#each chunk as app}
                      <button
                        data-library-item
                        class="ml-4 border-none relative transition-all shadow-lg hover:shadow-xl rounded-lg overflow-hidden bg-surface"
                        onclick={() => ($selectedApp = app)}
                      >
                        {#if updatesManager.getAppUpdate(app.appID)?.updateAvailable}
                          <div
                            class="absolute shadow-md top-2 right-2 h-6 z-2 flex items-center bg-accent text-accent-text-color rounded-lg flex-row justify-end gap-1 px-2"
                          >
                            <UpdateIcon
                              fill="currentColor"
                              width="16px"
                              height="16px"
                            />
                          </div>
                        {/if}
                        <Image
                          src={app.capsuleImage}
                          alt={app.name}
                          classifier={app.appID.toString() + '-capsule'}
                          onerror={(e) => {
                            const fallback = './favicon.png';
                            const img = e.currentTarget as HTMLImageElement;
                            if (img.src !== fallback) {
                              img.src = fallback;
                              img.style.opacity = '0.5';
                              (
                                (img.parentElement as HTMLElement)
                                  .children[1]! as HTMLElement
                              ).dataset.backup = 'enabled';
                            }
                          }}
                          class="w-32 object-cover"
                        />
                        <div
                          data-backup="disabled"
                          class="absolute inset-0 flex items-end justify-center data-[backup=disabled]:hidden"
                        >
                          <div
                            class="absolute inset-x-0 bottom-0 w-full h-1/2 pointer-events-none"
                            style="background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);"
                          ></div>
                          <p
                            class="text-white text-base py-4 text-center font-archivo z-1"
                          >
                            {app.name}
                          </p>
                        </div>
                      </button>
                    {/each}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          {#if loading}
            <div class="flex justify-center items-center py-16">
              <div
                class="animate-spin rounded-full h-8 w-8 border-b-2 border-border-muted"
              ></div>
            </div>
          {/if}
        </div>
      {:else}
        <div
          class="flex flex-col gap-4 w-full justify-center items-center h-full bg-background-color"
        >
          <img src="./favicon.png" alt="content" class="w-32 h-32 opacity-50" />
          <div class="text-center">
            <h1 class="text-2xl font-semibold text-accent-dark mb-2">
              Library Unsupported
            </h1>
            <p class="text-accent max-w-md">
              We're sorry, but library is currently unsupported for {os}. Use
              Steam + Proton to launch games, we already configure it for you!
            </p>
          </div>
        </div>
      {/if}
    {/await}
  </div>
{/key}

<style>
  [data-library-item]:hover {
    transform: perspective(600px) rotateX(4deg) scale(1.03) translateY(-6px);
    box-shadow:
      0 16px 36px 0 rgba(0, 0, 0, 0.2),
      0 2px 8px 0 rgba(0, 0, 0, 0.12);
    z-index: 1;
  }
</style>
