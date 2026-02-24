<script lang="ts">
  import type { LibraryInfo } from 'ogi-addon';
  import { onDestroy, onMount, tick } from 'svelte';
  import PlayPage from '../components/PlayPage.svelte';
  import { gameFocused } from '../store';
  import { writable, type Writable } from 'svelte/store';
  import Image from '../components/Image.svelte';
  import {
    getAllApps,
    getRecentlyPlayed,
    sortLibraryAlphabetically,
    filterLibrary,
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
  let os: string | undefined = $state(undefined);
  let osLoading = $state(true);
  let revealLibraryEntries = $state(false);
  let revealLibraryDelayActive = $state(false);
  let revealLibraryTimer: ReturnType<typeof setTimeout> | undefined;

  let { exitPlayPage = $bindable() } = $props();

  // Avoid infinite update loop by only assigning exitPlayPage once on mount
  onMount(() => {
    if (exitPlayPage) {
      exitPlayPage = () => {
        $selectedApp = undefined;
        void reloadLibrary().catch((err) => {
          console.error(
            'Failed to reload library when exiting play page:',
            err
          );
        });
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

  async function runInitialLibraryReveal() {
    revealLibraryEntries = false;
    revealLibraryDelayActive = false;
    if (revealLibraryTimer) {
      clearTimeout(revealLibraryTimer);
      revealLibraryTimer = undefined;
    }

    await tick();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
    revealLibraryDelayActive = true;
    revealLibraryEntries = true;
    revealLibraryTimer = setTimeout(() => {
      revealLibraryDelayActive = false;
    }, 1400);
  }

  function getLibraryEntryDelay(index: number): string {
    const delay = revealLibraryDelayActive ? Math.min(index * 45, 900) : 0;
    return `--library-entry-delay: ${delay}ms;`;
  }

  // Update filtered games when search query changes
  $effect(() => {
    filteredGames = filterLibrary(allGamesAlphabetical, searchQuery);
  });

  let wasPlayPageOpen = false;
  $effect(() => {
    const isPlayPageOpen = $selectedApp !== undefined;
    if (wasPlayPageOpen && !isPlayPageOpen && !osLoading) {
      void runInitialLibraryReveal();
    }
    wasPlayPageOpen = isPlayPageOpen;
  });

  onMount(async () => {
    const [resolvedOs] = await Promise.all([
      window.electronAPI.app.getOS(),
      reloadLibrary(),
    ]);

    os = resolvedOs;
    osLoading = false;
    await runInitialLibraryReveal();
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
    if (revealLibraryTimer) {
      clearTimeout(revealLibraryTimer);
    }
    unsubscribe();
  });

</script>

{#key library}
  <div class="relative w-full h-full overflow-x-hidden">
    {#if $selectedApp}
      <PlayPage libraryInfo={$selectedApp} {exitPlayPage} />
    {:else if osLoading}
      <div class="flex justify-center items-center w-full h-full">
        <div
          class="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-dark"
        ></div>
      </div>
    {:else if os === 'win32' || os === 'darwin' || os === 'linux'}
      <div class="flex flex-col w-full h-full overflow-y-auto gap-4 pb-8">
        <!-- Recently Played Section -->
        {#if recentlyPlayed.length > 0}
          <div class="space-y-6">
            <div class="bg-accent-lighter px-4 py-2 rounded-lg">
              <h2 class="text-xl font-semibold text-accent-dark">
                Recently Played
              </h2>
            </div>
            <div
              class="flex gap-4 flex-row overflow-x-auto pt-8 -mt-8 pb-6 -mb-6 overflow-y-hidden px-4"
            >
              {#each recentlyPlayed as app, index}
                <div class="library-entry-shell shrink-0">
                  <button
                    data-library-item
                    class="library-entry border-none relative transition-all shadow-lg hover:shadow-xl rounded-lg overflow-hidden bg-surface"
                    class:library-entry-visible={revealLibraryEntries}
                    class:library-entry-revealing={revealLibraryDelayActive}
                    style={getLibraryEntryDelay(index)}
                    onclick={() => ($selectedApp = app)}
                  >
                    {#if updatesManager.getAppUpdate(app.appID)?.updateAvailable}
                      <div
                        class="absolute shadow-md top-2 right-2 h-6 z-2 flex items-center bg-yellow-500 rounded-lg flex-row justify-end gap-1 px-2"
                      >
                        <UpdateIcon fill="#ffffff" width="16px" height="16px" />
                        <p
                          class="text-white text-sm font-open-sans font-semibold"
                        >
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
                </div>
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
                class="block w-64 pl-9 pr-3 py-2 border border-accent rounded-md text-sm bg-surface text-text-primary placeholder-accent caret-accent-dark focus:outline-none focus:ring-1 focus:ring-accent-dark focus:border-accent-dark transition-colors"
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
                <h1 class="text-xl text-text-secondary mb-2">
                  {searchQuery ? 'No games found' : 'No games in library'}
                </h1>
                {#if searchQuery}
                  <p class="text-text-muted">Try adjusting your search terms</p>
                {/if}
              </div>
            </div>
          {:else}
            <div class="grid grid-cols-5 gap-4 w-full">
              {#each filteredGames as app, appIndex}
                <div class="library-entry-shell">
                  <button
                    data-library-item
                    class="library-entry w-full border-none relative transition-all shadow-lg hover:shadow-xl rounded-lg overflow-hidden bg-white"
                    class:library-entry-visible={revealLibraryEntries}
                    class:library-entry-revealing={revealLibraryDelayActive}
                    style={getLibraryEntryDelay(recentlyPlayed.length + appIndex)}
                    onclick={() => ($selectedApp = app)}
                  >
                    {#if updatesManager.getAppUpdate(app.appID)?.updateAvailable}
                      <div
                        class="absolute shadow-md top-2 right-2 h-6 z-2 flex items-center bg-yellow-500 rounded-lg flex-row justify-end gap-1 px-2"
                      >
                        <UpdateIcon fill="#ffffff" width="16px" height="16px" />
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
                      class="w-full object-cover"
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
                </div>
              {/each}
            </div>
          {/if}
        </div>

        {#if loading}
          <div class="flex justify-center items-center py-16">
            <div
              class="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"
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
  </div>
{/key}

<style>
  .library-entry-shell {
    position: relative;
    padding: 20px 10px 18px;
    margin: -20px -10px -18px;
    isolation: isolate;
  }

  .library-entry-shell:hover,
  .library-entry-shell:focus-within {
    z-index: 12;
  }

  .library-entry-shell [data-library-item].library-entry {
    transform-origin: center top;
  }

  [data-library-item].library-entry {
    opacity: 0;
    transform: translateY(20px);
    transition:
      opacity 420ms cubic-bezier(0.22, 1, 0.36, 1),
      transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
    transition-delay: 0ms;
    will-change: transform, opacity;
  }

  [data-library-item].library-entry.library-entry-visible {
    opacity: 1;
    transform: translateY(0);
  }

  [data-library-item].library-entry.library-entry-visible.library-entry-revealing {
    transition-delay: var(--library-entry-delay, 0ms);
  }

  [data-library-item].library-entry:hover {
    opacity: 1;
    transform: perspective(1000px) rotateX(5deg) scale(1.1) translateY(-12px)
      translateZ(44px);
    box-shadow:
      0 28px 42px 0 rgba(0, 0, 0, 0.24),
      0 10px 16px 0 rgba(0, 0, 0, 0.16);
    z-index: 8;
  }

  [data-library-item].library-entry:focus-visible {
    opacity: 1;
    transform: perspective(1000px) rotateX(3deg) scale(1.05) translateY(-8px)
      translateZ(28px);
    z-index: 8;
  }

  @media (prefers-reduced-motion: reduce) {
    [data-library-item].library-entry {
      opacity: 1;
      transform: none;
      transition: none;
    }
  }
</style>
