<script lang="ts">
  import type { LibraryInfo, SearchResult } from 'ogi-addon';
  import PlayIcon from '../Icons/PlayIcon.svelte';
  import {
    currentDownloads,
    currentStorePageOpened,
    currentStorePageOpenedStorefront,
    gamesLaunched,
    launchGameTrigger,
    setHeaderBackButton,
    clearHeaderBackButton,
  } from '../store';
  import { onDestroy, onMount } from 'svelte';
  import SettingsFilled from '../Icons/SettingsFilled.svelte';
  import GameConfiguration from './GameConfiguration.svelte';
  import { fly } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import Image from './Image.svelte';
  import { fetchAddonsWithConfigure, runTask, safeFetch } from '../utils';
  import AddonPicture from './AddonPicture.svelte';
  import { updatesManager, appUpdates } from '../states.svelte';
  import UpdateIcon from '../Icons/UpdateIcon.svelte';
  import UpdateAppModal from './built/UpdateAppModal.svelte';

  let updateInfo = $derived.by(() => {
    return updatesManager.getAppUpdate(libraryInfo.appID);
  });

  let showUpdateModal = $state(false);

  interface Props {
    libraryInfo: LibraryInfo;
    exitPlayPage: () => void;
  }

  let { libraryInfo = $bindable(), exitPlayPage }: Props = $props();

  let requiresSteamReadd = $derived(
    appUpdates.requiredReadds.some((r) => r.appID === libraryInfo.appID)
  );

  async function doesLinkExist(url: string | undefined) {
    if (!url) return false;
    const response = await window.electronAPI.app.axios({
      method: 'get',
      url: url,
      headers: {
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    return response.status === 200;
  }

  let playButton: HTMLButtonElement | undefined = $state(undefined);
  let openedGameConfiguration = $state(false);

  async function launchGame() {
    if ($gamesLaunched[libraryInfo.appID] === 'launched') return;
    console.log('Launching game with appID: ' + libraryInfo.appID);
    await window.electronAPI.app.launchGame('' + libraryInfo.appID);
    gamesLaunched.update((games) => {
      games[libraryInfo.appID] = 'launched';
      return games;
    });
    if (!playButton) return;
    playButton.disabled = true;
    playButton.querySelector('p')!!.textContent = 'PLAYING';
    playButton.querySelector('svg')!!.style.display = 'none';
    if (!window.electronAPI.fs.exists('./internals')) {
      window.electronAPI.fs.mkdir('./internals');
      window.electronAPI.fs.write(
        './internals/apps.json',
        JSON.stringify([], null, 2)
      );
    }
    if (window.electronAPI.fs.exists('./internals/apps.json')) {
      let appsOrdered: number[] = JSON.parse(
        window.electronAPI.fs.read('./internals/apps.json')
      );
      // remove the appID from the list
      appsOrdered = appsOrdered.filter((id) => id !== libraryInfo.appID);
      // add it to the front
      appsOrdered.unshift(libraryInfo.appID);
      window.electronAPI.fs.write(
        './internals/apps.json',
        JSON.stringify(appsOrdered, null, 2)
      );
    }
  }

  const unsubscribe2 = launchGameTrigger.subscribe((game) => {
    console.log('launchGameTrigger', libraryInfo.appID);
    setTimeout(() => {
      if (game === libraryInfo.appID) {
        launchGame();
        launchGameTrigger.set(undefined);
      }
    }, 100);
  });

  const unsubscribe = gamesLaunched.subscribe((games) => {
    if (!playButton) return;
    // wait for playButton to be defined
    if (!games[libraryInfo.appID]) {
      playButton.disabled = false;
      playButton.querySelector('p')!!.textContent = 'PLAY';
      playButton.querySelector('svg')!!.style.display = 'block';
      return;
    }
    if (games[libraryInfo.appID] === 'launched') {
      playButton.disabled = true;
      playButton.querySelector('p')!!.textContent = 'PLAYING';
      playButton.querySelector('svg')!!.style.display = 'none';
    } else if (games[libraryInfo.appID] === 'error') {
      console.log('Error launching game');
      playButton.disabled = false;
      playButton.querySelector('p')!!.textContent = 'ERROR';
      playButton.querySelector('svg')!!.style.display = 'none';
    }
  });

  function openGameConfiguration() {
    openedGameConfiguration = true;
  }

  function onFinish(data: any) {
    openedGameConfiguration = false;
    // set the configuration for the game
    if (!data) return;
    libraryInfo.cwd = data.cwd;
    libraryInfo.launchExecutable = data.launchExecutable;
    libraryInfo.launchArguments = data.launchArguments;
    window.electronAPI.fs.write(
      './library/' + libraryInfo.appID + '.json',
      JSON.stringify(libraryInfo, null, 2)
    );
  }

  onDestroy(() => {
    unsubscribe();
    unsubscribe2();
    clearHeaderBackButton();
  });

  let searchingAddons: { [key: string]: SearchResult[] | undefined } = $state(
    {}
  );
  let addonsMap: Map<string, { id: string; name: string }> = $state(new Map());
  let settledAddons = $derived.by(() => {
    return (
      Object.values(searchingAddons).filter((task) => task !== undefined)
        .length === Object.keys(searchingAddons).length
    );
  });

  $effect(() => {
    console.log('searchingAddons', searchingAddons);
    console.log('settledAddons', settledAddons);
  });

  onMount(async () => {
    // Set up the header back button
    console.log('PlayPage mounted, setting header back button');
    setHeaderBackButton(() => {
      console.log('Header back button clicked');
      exitPlayPage();
    }, 'Back to library');

    const addons = await fetchAddonsWithConfigure();
    addonsMap = new Map(
      addons.map((addon) => [addon.id, { id: addon.id, name: addon.name }])
    );
    const addonsWithStorefront = addons.filter((addon) =>
      addon.storefronts.includes(libraryInfo.storefront)
    );

    if (addonsWithStorefront.length === 0) return;
    for (const addon of addonsWithStorefront) {
      searchingAddons[addon.id] = undefined;
      safeFetch(
        'search',
        {
          addonID: addon.id,
          appID: libraryInfo.appID,
          storefront: libraryInfo.storefront,
          for: 'task',
        },
        { consume: 'json' }
      )
        .then((tasks) => {
          console.log('tasks', tasks);
          searchingAddons[addon.id] = tasks;
        })
        .catch((ex) => {
          console.error(ex);
          searchingAddons[addon.id] = [];
        });
    }
    await Promise.allSettled(
      Object.values(searchingAddons).map((task) => task)
    );
  });

  function handleRunTask(task: SearchResult, addonID: string) {
    console.log('Running task: ' + task.name);
    const addon = addonsMap.get(addonID);
    runTask(
      {
        ...task,
        addonSource: addonID,
        addonName: addon?.name || addonID,
        coverImage: libraryInfo.coverImage,
        storefront: libraryInfo.storefront,
        capsuleImage: libraryInfo.capsuleImage,
      },
      libraryInfo.cwd,
      libraryInfo
    );
  }
</script>

{#if openedGameConfiguration}
  <GameConfiguration gameInfo={libraryInfo} {onFinish} {exitPlayPage} />
{/if}

{#if showUpdateModal && updateInfo}
  <UpdateAppModal
    {libraryInfo}
    updateVersion={updateInfo.updateVersion}
    onClose={() => (showUpdateModal = false)}
  />
{/if}

<div
  class="flex flex-col top-0 left-0 overflow-y-auto absolute w-full h-full bg-white z-3 animate-fade-in-pop-fast"
  out:fly={{ x: 100, duration: 500, easing: quintOut }}
>
  <!-- Hero Banner Section -->
  <div class="relative w-full h-64 overflow-hidden">
    <Image
      classifier={libraryInfo.appID.toString() + '-cover'}
      src={libraryInfo.coverImage}
      alt={libraryInfo.name}
      class="w-full h-full object-cover rounded-lg"
    />
    <!-- Overlay with game info -->
    <div
      class="absolute bottom-0 left-0 right-0 p-6"
      style="background: linear-gradient(to top, var(--color-overlay-bg), transparent);"
    >
      <h1 class="text-4xl font-archivo font-bold text-white mb-2">
        {libraryInfo.name}
      </h1>
      <!-- <div class="text-sm text-gray-200">
        <span class="text-gray-300">App ID:</span>
        {libraryInfo.appID}
        {#if libraryInfo.storefront}
          <span class="mx-4"></span>
          <span class="text-gray-300">Store:</span>
          {libraryInfo.storefront}
        {/if}
      </div> -->
    </div>

    <!-- Title image overlay if available -->
    {#await doesLinkExist(libraryInfo.titleImage)}
      <div class="absolute z-2 w-full h-full"></div>
    {:then result}
      {#if result}
        <img
          src={libraryInfo.titleImage}
          alt="logo"
          class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-3 max-w-xs max-h-32 object-contain drop-shadow-lg"
        />
      {/if}
    {/await}
  </div>

  <!-- Action Buttons at Top -->
  <div class="bg-accent-lighter px-6 py-4 flex items-center gap-3 rounded-b-lg">
    {#if updateInfo && !$currentDownloads.find((download) => download.appID === libraryInfo.appID && download.status !== 'error' && download.status !== 'completed' && download.status !== 'seeding' && download.status !== 'setup-complete')}
      <button
        class="px-6 py-3 flex border-none rounded-lg justify-center bg-yellow-500 hover:bg-yellow-600 items-center gap-2 disabled:bg-yellow-500 disabled:cursor-not-allowed transition-colors duration-200"
        onclick={() => (showUpdateModal = true)}
      >
        <UpdateIcon fill="#ffffff" />
        <p class="font-archivo font-semibold text-white">
          Update to {updateInfo.updateVersion?.slice(0, 8)}
        </p>
      </button>
      <button
        aria-label="Ignore update"
        onclick={() => {
          updatesManager.removeAppUpdate(libraryInfo.appID);
        }}
        class="px-3 py-3 flex border-none rounded-lg justify-center bg-red-500 hover:bg-red-600 items-center gap-2 disabled:bg-gray-500 disabled:cursor-not-allowed transition-colors duration-200"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          height="20px"
          viewBox="0 -960 960 960"
          width="20px"
          fill="white"
        >
          <path
            d="M480-424 284-228q-17 17-44 17t-44-17q-17-17-17-44t17-44l196-196-196-196q-17-17-17-44t17-44q17-17 44-17t44 17l196 196 196-196q17-17 44-17t44 17q17 17 17 44t-17 44L536-480l196 196q17 17 17 44t-17 44q-17 17-44 17t-44-17L480-424Z"
          />
        </svg>
      </button>
    {:else if $currentDownloads.find((download) => download.appID === libraryInfo.appID && download.status !== 'error' && download.status !== 'completed' && download.status !== 'seeding' && download.status !== 'setup-complete')}
      <button
        class="px-6 py-3 flex border-none rounded-lg justify-center bg-yellow-500 items-center gap-2 cursor-not-allowed transition-colors duration-200"
        disabled
      >
        <UpdateIcon fill="#ffffff" />
        <p class="font-archivo font-semibold text-white">Updating</p>
      </button>
    {:else}
      {#await window.electronAPI.app.getOS()}
        <div class="flex justify-center items-center w-full h-full"></div>
      {:then os}
        {#if (os === 'linux' || os === 'darwin') && libraryInfo.launchExecutable.endsWith('.exe')}
          <div class="relative group">
            <button
              class="px-6 py-3 flex border-none rounded-lg justify-center bg-gray-500 items-center gap-2 disabled:bg-gray-500 disabled:cursor-not-allowed transition-colors duration-200"
              disabled
            >
              <PlayIcon fill="#ffffff" />
              <p class="font-archivo font-semibold text-white">Play</p>
            </button>
            <div
              class="absolute top-full left-0 mt-2 px-3 py-2 bg-accent-lighter drop-shadow-md border border-accent-dark flex flex-row gap-2 items-center text-accent-dark text-sm rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10"
            >
              <img src="./error.svg" alt="error" class="w-4 h-4" />
              <p class="font-archivo font-semibold text-accent-dark pr-4">
                You can only play Windows games through Steam using Proton
              </p>
            </div>
          </div>
        {:else}
          <button
            bind:this={playButton}
            class="px-6 py-3 flex border-none rounded-lg justify-center bg-green-500 hover:bg-green-600 items-center gap-2 disabled:bg-yellow-500 disabled:cursor-not-allowed transition-colors duration-200"
            onclick={() => launchGameTrigger.set(libraryInfo.appID)}
          >
            <PlayIcon fill="#86efac" />
            <p class="font-archivo font-semibold text-white">PLAY</p>
          </button>
        {/if}
      {/await}
    {/if}

    <button
      class="px-4 py-3 flex border-none rounded-lg justify-center bg-accent-light hover:bg-accent-light/80 text-accent-dark items-center gap-2 transition-colors duration-200"
      onclick={openGameConfiguration}
    >
      <SettingsFilled fill="#2D626A" />
      <span class="font-medium">Settings</span>
    </button>

    <button
      class="px-4 py-3 flex border-none rounded-lg justify-center bg-accent-light hover:bg-accent-light/80 text-accent-dark items-center gap-2 transition-colors duration-200"
      onclick={() => {
        currentStorePageOpened.set(libraryInfo.appID);
        currentStorePageOpenedStorefront.set(libraryInfo.storefront);
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        class="w-5 h-5 fill-accent-dark"
      >
        <path
          d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 17C11.45 17 11 16.55 11 16V12C11 11.45 11.45 11 12 11C12.55 11 13 11.45 13 12V16C13 16.55 12.55 17 12 17ZM13 9H11V7H13V9Z"
        />
      </svg>
      <span class="font-medium">More Info</span>
    </button>
  </div>

  <!-- Steam Re-add Banner -->
  {#if requiresSteamReadd}
    <div
      class="bg-accent-lighter rounded-lg p-5 mx-0 mt-6 flex flex-col gap-3"
      in:fly={{ y: -20, duration: 300 }}
    >
      <div class="flex items-start gap-3">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          class="w-6 h-6 fill-accent-dark shrink-0 mt-0.5"
        >
          <path
            d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
          />
        </svg>
        <div>
          <h3 class="text-base font-archivo font-bold text-accent-dark">
            Steam Re-add Required
          </h3>
          <p class="text-accent-dark text-sm">
            This game has been updated. To continue playing, you must re-add it
            to Steam.
          </p>
        </div>
      </div>
      <div class="flex gap-3">
        <button
          class="px-4 py-2 bg-accent-light hover:bg-accent-light/80 text-accent-dark font-archivo font-semibold rounded-lg border-none flex items-center justify-center gap-2 transition-colors duration-200 flex-1 disabled:bg-gray-500/50 disabled:cursor-not-allowed"
          onclick={async (event) => {
            try {
              (event.currentTarget as HTMLButtonElement).disabled = true;

              // Get the old Steam app ID from requiredReadds if available
              const requiredReadd = appUpdates.requiredReadds.find(
                (r) => r.appID === libraryInfo.appID
              );
              const oldSteamAppId =
                requiredReadd?.steamAppId && requiredReadd.steamAppId !== 0
                  ? requiredReadd.steamAppId
                  : undefined;

              await window.electronAPI.app.addToSteam(
                libraryInfo.appID,
                oldSteamAppId
              );

              appUpdates.requiredReadds = appUpdates.requiredReadds.filter(
                (r) => r.appID !== libraryInfo.appID
              );
            } catch (error) {
              console.error(error);
            }
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            class="w-5 h-5 fill-accent-dark"
          >
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
          </svg>
          Add to Steam
        </button>
      </div>
    </div>
  {/if}

  <!-- Addon Task Grid -->
  <div class="grid grid-cols-3 gap-4 mt-6">
    {#if settledAddons}
      {#each Object.keys(searchingAddons) as addonID, index}
        {#each searchingAddons[addonID]!!.filter((task) => task.downloadType === 'task') as task, taskIndex}
          <div
            class="bg-accent-lighter rounded-lg p-4 flex flex-col gap-2"
            in:fly={{ y: 30, duration: 400, delay: 50 * (index + taskIndex) }}
          >
            <div class="flex flex-row gap-2 items-center mb-2">
              <AddonPicture addonId={addonID} class="w-12 h-12 rounded-lg" />
              <h3 class="text-lg font-semibold text-accent-dark">
                {task.name}
              </h3>
            </div>

            <button
              class="px-4 py-2 bg-accent-light rounded-lg border-none text-accent-dark hover:bg-accent-light/80 transition-colors duration-200"
              onclick={() => handleRunTask(task, addonID)}>Run Task</button
            >
          </div>
        {/each}
      {/each}
    {:else}
      {#each Array(3) as _}
        <div
          class="bg-accent-lighter rounded-lg p-4 flex flex-col gap-2 animate-pulse"
        >
          <div class="flex flex-row gap-2 items-center mb-2">
            <div class="w-12 h-12 bg-accent-light rounded-lg"></div>
            <div class="h-6 bg-accent-light rounded w-32"></div>
          </div>
          <div class="h-10 bg-accent-light rounded-lg"></div>
        </div>
      {/each}
    {/if}
  </div>
</div>
