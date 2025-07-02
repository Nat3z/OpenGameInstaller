<script lang="ts">
  import { onMount } from "svelte";
  import ConfigView from "./views/ConfigView.svelte";
  import GameInstallView from "./views/GameInstallView.svelte";
  import ClientOptionsView from "./views/ClientOptionsView.svelte";
  import DownloadView from "./views/DownloadView.svelte";
  import DownloadManager from "./components/DownloadManager.svelte";
  import OOBE from "./views/OutOfBoxExperience.svelte";

  import { fetchAddonsWithConfigure, getConfigClientOption } from "./utils";
  import Notifications from "./components/Notifications.svelte";
  import {
    addonUpdates,
    currentStorePageOpened,
    currentStorePageOpenedSource,
    currentStorePageOpenedStorefront,
    gameFocused,
    launchGameTrigger,
    selectedView,
    viewOpenedWhenChanged,
    type Views,
  } from "./store";
  import SteamStorePage from "./components/SteamStorePage.svelte";
  import InputScreenManager from "./components/InputScreenManager.svelte";
  import PlayIcon from "./Icons/PlayIcon.svelte";
  import LibraryView from "./views/LibraryView.svelte";
  import GameManager from "./components/GameManager.svelte";
  import CustomStorePage from "./components/CustomStorePage.svelte";
  import Tasks from "./views/Tasks.svelte";

  // post config to server for each addon

  let finishedOOBE = $state(true);
  let loading = $state(true);

  let recentlyLaunchedApps: LibraryInfo[] = $state([]);
  onMount(() => {
    loading = true;
    setTimeout(() => {
      fetchAddonsWithConfigure();
      const installedOption = getConfigClientOption("installed") as {
        installed: boolean;
      };
      if (!installedOption || !installedOption.installed) {
        finishedOOBE = false;
      }
      loading = false;

      // get recently launched apps
      updateRecents();
    }, 100);
  });

  function updateRecents() {
    let exists = window.electronAPI.fs.exists("./internals/apps.json");
    let itemsAdded = 0;
    if (exists) {
      let apps: number[] = JSON.parse(
        window.electronAPI.fs.read("./internals/apps.json")
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

  document.addEventListener("addon:update-available", (event) => {
    if (event instanceof CustomEvent) {
      const { detail } = event;
      addonUpdates.update((value) => {
        value.push(detail);
        return value;
      });
    }
  });
  document.addEventListener("addon:updated", (event) => {
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

    if (isStoreOpen && $selectedView === view) {
      // If the store is open and the same tab is clicked again, close the store
      isStoreOpen = false;
      currentStorePageOpened.set(undefined);
      currentStorePageOpenedSource.set(undefined);
      heldPageOpened = undefined;
      viewOpenedWhenChanged.set(undefined);
      console.log("Removing store from view");
    } else if (
      view === $viewOpenedWhenChanged &&
      heldPageOpened !== undefined
    ) {
      // If switching back to the tab that had the store, reopen the store
      currentStorePageOpened.set(heldPageOpened);
      selectedView.set(view);
      isStoreOpen = true;
      console.log("Switching back to tab that had the store");
    } else {
      // Otherwise, just switch to the new tab
      if ($selectedView === view && view === "library") {
        exitPlayPage();
      } else {
        selectedView.set(view);
        currentStorePageOpened.set(undefined);
        isStoreOpen = false;
        console.log("Otherwise, just switch to the new tab");
      }
    }
    iTriggeredIt = false;
  }
  launchGameTrigger.subscribe(() => {
    setTimeout(() => {
      updateRecents();
    }, 200);
  });
  function playGame(gameID: number) {
    console.log("Playing game with ID: " + gameID);
    selectedView.set("library");
    viewOpenedWhenChanged.set("library");
    currentStorePageOpened.set(undefined);
    currentStorePageOpenedStorefront.set(undefined);
    gameFocused.set(gameID);
    setTimeout(() => {
      launchGameTrigger.set(gameID);
    }, 5);
  }
</script>

<Notifications />
{#if !finishedOOBE}
  <OOBE finishedSetup={() => (finishedOOBE = true)} />
{/if}

{#if !loading}
  <div
    class="flex items-center justify-center flex-row h-screen w-screen fixed left-0 top-0"
  >
    <nav
      class="flex justify-start flex-col items-center h-full w-3/12"
    >
      <div class="flex justify-start items-center flex-col p-2">
        <img src="./favicon.png" alt="logo" class="w-5/12 h-5/12" />
      </div>

      <button
        onclick={() => setView("library")}
        data-selected-header={$selectedView === "library"}
        aria-label="Library"
      >
        <svg class="fill-accent-dark w-8 h-8" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg" fill="none">
          <path d="M39 15.87V3C39 1.35 37.65 0 36 0H24C22.35 0 21 1.35 21 3V15.87C21 16.26 21.15 16.65 21.45 16.92L28.95 24.42C29.55 25.02 30.48 25.02 31.08 24.42L38.58 16.92C38.85 16.65 39 16.29 39 15.87ZM15.87 21H3C1.35 21 0 22.35 0 24V36C0 37.65 1.35 39 3 39H15.87C16.26 39 16.65 38.85 16.92 38.55L24.42 31.05C25.02 30.45 25.02 29.52 24.42 28.92L16.92 21.42C16.65 21.15 16.29 21 15.87 21ZM21 44.13V57C21 58.65 22.35 60 24 60H36C37.65 60 39 58.65 39 57V44.13C39 43.74 38.85 43.35 38.55 43.08L31.05 35.58C30.45 34.98 29.52 34.98 28.92 35.58L21.42 43.08C21.15 43.35 21 43.71 21 44.13ZM43.05 21.45L35.55 28.95C34.95 29.55 34.95 30.48 35.55 31.08L43.05 38.58C43.32 38.85 43.71 39.03 44.1 39.03H57C58.65 39.03 60 37.68 60 36.03V24.03C60 22.38 58.65 21.03 57 21.03H44.13C43.71 21 43.35 21.15 43.05 21.45Z" fill="#2D626A"/>
        </svg>
      </button>
      <button
        onclick={() => setView("downloader")}
        data-selected-header={$selectedView === "downloader"}
      >
        <img src="./download.svg" alt="Downloads" />
      </button>
      <button
        onclick={() => setView("config")}
        data-selected-header={$selectedView === "config"}
      >
        <img src="./apps.svg" alt="addon" />
      </button>
      <button
        onclick={() => setView("tasks")}
        data-selected-header={$selectedView === "tasks"}
      >
        <img src="./tasks.svg" alt="Tasks" />
      </button>
      <button
        onclick={() => setView("clientoptions")}
        data-selected-header={$selectedView === "clientoptions"}
      >
        <img src="./settings.svg" alt="Settings" />
      </button>

      <span class="flex flex-col justify-start items-center w-full p-4">
        {#await window.electronAPI.app.getOS() then os}
          {#if os === "win32"}
            {#if recentlyLaunchedApps.length > 0}
              <h1 class="text-left !font-archivo w-full">Recently Played</h1>
              {#each recentlyLaunchedApps as app}
                <div
                  data-recently-item
                  class="flex flex-row justify-start items-center w-full gap-4 p-2 h-22 rounded hover:bg-gray-100 hover:cursor-pointer transition-colors"
                  onclick={() => playGame(app.appID)}
                >
                  <img
                    src={app.capsuleImage}
                    alt="capsule"
                    class="w-12 h-22 rounded"
                  />
                  <div class="flex flex-col">
                    <h1 class="font-open-sans text-sm">{app.name}</h1>
                    <div class="flex flex-row gap-2">
                      <PlayIcon width="12px" fill="#d1d5db" />

                      <p class="font-archivo text-gray-300">Start</p>
                    </div>
                  </div>
                </div>
              {/each}
            {/if}
          {/if}
        {/await}
      </span>
    </nav>
    <main
      class="flex items-center flex-col gap-4 w-full h-full overflow-y-auto"
    >
      {#if $currentStorePageOpened}
        {#if $currentStorePageOpenedStorefront === "steam"}
          <SteamStorePage appID={$currentStorePageOpened} />
        {:else if $currentStorePageOpenedSource && $currentStorePageOpenedStorefront === "internal"}
          <CustomStorePage
            appID={$currentStorePageOpened}
            addonSource={$currentStorePageOpenedSource}
          />
        {/if}
      {:else if $selectedView === "config"}
        <ConfigView />
      {:else if $selectedView === "gameInstall"}
        <GameInstallView />
      {:else if $selectedView === "clientoptions"}
        <ClientOptionsView />
      {:else if $selectedView === "downloader"}
        <DownloadView />
      {:else if $selectedView === "library"}
        <LibraryView bind:exitPlayPage />
      {:else if $selectedView === "tasks"}
        <Tasks />
      {:else}
        <p>Unknown view</p>
      {/if}

      <DownloadManager />
    </main>
    <InputScreenManager />
    <GameManager />
  </div>
{/if}

<style global>
  @tailwind base;
  @tailwind components;
  @tailwind utilities;

  * {
    -webkit-touch-callout: none; /* iOS Safari */
    -webkit-user-select: none; /* Safari */
    -khtml-user-select: none; /* Konqueror HTML */
    -moz-user-select: none; /* Old versions of Firefox */
    -ms-user-select: none; /* Internet Explorer/Edge */
    user-select: none; /* Non-prefixed version, currently
																		supported by Chrome, Edge, Opera and Firefox */
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
  input[type="text"]:focus,
  input[type="password"]:focus,
  input[type="number"]:focus {
    @apply outline outline-accent-light;
  }

  button {
    @apply font-open-sans;
  }

  nav button {
    @apply border-none rounded p-4 py-4 focus:bg-accent-lighter text-accent-dark;
  }
  nav button[data-selected-header="true"] {
    @apply bg-accent-lighter;
  }
  nav button img {
    @apply w-6 h-6 pointer-events-none;
  }

  [data-recently-item]:hover p {
    @apply text-green-300 transition-colors duration-300;
  }
  [data-recently-item]:hover svg {
    @apply fill-green-300 transition-colors duration-300;
  }
</style>
