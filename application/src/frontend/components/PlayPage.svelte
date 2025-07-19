<script lang="ts">
  import type { LibraryInfo } from "ogi-addon";
  import PlayIcon from "../Icons/PlayIcon.svelte";
  import {
    currentStorePageOpened,
    currentStorePageOpenedSource,
    currentStorePageOpenedStorefront,
    gamesLaunched,
    launchGameTrigger,
  } from "../store";
  import { onDestroy } from "svelte";
  import SettingsFilled from "../Icons/SettingsFilled.svelte";
  import GameConfiguration from "./GameConfiguration.svelte";

  interface Props {
    libraryInfo: LibraryInfo;
    exitPlayPage: () => void;
  }

  let { libraryInfo = $bindable(), exitPlayPage }: Props = $props();
  
  async function doesLinkExist(url: string | undefined) {
    if (!url) return false;
    const response = await window.electronAPI.app.axios({
      method: "get",
      url: url,
      headers: {
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    return response.status === 200;
  }

  let playButton: HTMLButtonElement | undefined = $state(undefined);
  let openedGameConfiguration = $state(false);
  
  async function launchGame() {
    if ($gamesLaunched[libraryInfo.appID] === "launched") return;
    console.log("Launching game with appID: " + libraryInfo.appID);
    await window.electronAPI.app.launchGame("" + libraryInfo.appID);
    gamesLaunched.update((games) => {
      games[libraryInfo.appID] = "launched";
      return games;
    });
    if (!playButton) return;
    playButton.disabled = true;
    playButton.querySelector("p")!!.textContent = "PLAYING";
    playButton.querySelector("svg")!!.style.display = "none";
    if (!window.electronAPI.fs.exists("./internals")) {
      window.electronAPI.fs.mkdir("./internals");
      window.electronAPI.fs.write(
        "./internals/apps.json",
        JSON.stringify([], null, 2)
      );
    }
    if (window.electronAPI.fs.exists("./internals/apps.json")) {
      let appsOrdered: number[] = JSON.parse(
        window.electronAPI.fs.read("./internals/apps.json")
      );
      // remove the appID from the list
      appsOrdered = appsOrdered.filter((id) => id !== libraryInfo.appID);
      // add it to the front
      appsOrdered.unshift(libraryInfo.appID);
      window.electronAPI.fs.write(
        "./internals/apps.json",
        JSON.stringify(appsOrdered, null, 2)
      );
    }
  }

  const unsubscribe2 = launchGameTrigger.subscribe((game) => {
    console.log("launchGameTrigger", libraryInfo.appID);
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
      playButton.querySelector("p")!!.textContent = "PLAY";
      playButton.querySelector("svg")!!.style.display = "block";
      return;
    }
    if (games[libraryInfo.appID] === "launched") {
      playButton.disabled = true;
      playButton.querySelector("p")!!.textContent = "PLAYING";
      playButton.querySelector("svg")!!.style.display = "none";
    } else if (games[libraryInfo.appID] === "error") {
      console.log("Error launching game");
      playButton.disabled = false;
      playButton.querySelector("p")!!.textContent = "ERROR";
      playButton.querySelector("svg")!!.style.display = "none";
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
      "./library/" + libraryInfo.appID + ".json",
      JSON.stringify(libraryInfo, null, 2)
    );
  }
  
  onDestroy(() => {
    unsubscribe();
    unsubscribe2();
  });
</script>

{#if openedGameConfiguration}
  <GameConfiguration gameInfo={libraryInfo} {onFinish} {exitPlayPage} />
{/if}

<div class="flex flex-col top-0 left-0 absolute w-full h-full bg-white z-[2] animate-fade-in-pop-fast">
  <!-- Hero Banner Section -->
  <div class="relative w-full h-64 overflow-hidden">
    <img
      src={libraryInfo.coverImage}
      alt={libraryInfo.name}
      class="w-full h-full object-cover rounded-lg"
    />
    <!-- Overlay with game info -->
    <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-6">
      <h1 class="text-4xl font-archivo font-bold text-white mb-2">{libraryInfo.name}</h1>
      <div class="text-sm text-gray-200">
        <span class="text-gray-300">App ID:</span> {libraryInfo.appID}
        {#if libraryInfo.storefront}
          <span class="mx-4"></span>
          <span class="text-gray-300">Store:</span> {libraryInfo.storefront}
        {/if}
      </div>
    </div>
    
    <!-- Title image overlay if available -->
    {#await doesLinkExist(libraryInfo.titleImage)}
      <div class="absolute z-[2] w-full h-full"></div>
    {:then result}
      {#if result}
        <img
          src={libraryInfo.titleImage}
          alt="logo"
          class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[3] max-w-xs max-h-32 object-contain drop-shadow-lg"
        />
      {/if}
    {/await}
  </div>

  <!-- Action Buttons at Top -->
  <div class="bg-accent-lighter px-6 py-4 flex items-center gap-3 rounded-b-lg">
    <button
      bind:this={playButton}
      class="px-6 py-3 flex border-none rounded-lg justify-center bg-green-500 hover:bg-green-600 items-center gap-2 disabled:bg-yellow-500 disabled:cursor-not-allowed transition-colors duration-200"
      onclick={() => launchGameTrigger.set(libraryInfo.appID)}
    >
      <PlayIcon fill="#86efac" />
      <p class="font-archivo font-semibold text-white">PLAY</p>
    </button>

    <button
      class="px-4 py-3 flex border-none rounded-lg justify-center bg-accent-light hover:bg-opacity-80 text-accent-dark items-center gap-2 transition-colors duration-200"
      onclick={openGameConfiguration}
    >
      <SettingsFilled fill="#2D626A" />
      <span class="font-medium">Settings</span>
    </button>

    <button
      class="px-4 py-3 flex border-none rounded-lg justify-center bg-accent-light hover:bg-opacity-80 text-accent-dark items-center gap-2 transition-colors duration-200"
      onclick={() => {
        currentStorePageOpened.set(libraryInfo.appID);
        currentStorePageOpenedSource.set(libraryInfo.addonsource);
        currentStorePageOpenedStorefront.set(libraryInfo.storefront);
      }}
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-5 h-5 fill-accent-dark">
        <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 17C11.45 17 11 16.55 11 16V12C11 11.45 11.45 11 12 11C12.55 11 13 11.45 13 12V16C13 16.55 12.55 17 12 17ZM13 9H11V7H13V9Z"/>
      </svg>
      <span class="font-medium">More Info</span>
    </button>
  </div>

  <!-- Game Configuration Info -->
  <div class="flex-1 p-6">
    <div class="bg-accent-lighter rounded-lg p-4">
      <h3 class="text-lg font-semibold text-accent-dark mb-3">Game Configuration</h3>
      <div class="space-y-2 text-sm">
        <div class="flex justify-between">
          <span class="text-gray-600">Working Directory:</span>
          <span class="font-mono text-gray-800">{libraryInfo.cwd || "Not set"}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600">Executable:</span>
          <span class="font-mono text-gray-800">{libraryInfo.launchExecutable || "Not set"}</span>
        </div>
        {#if libraryInfo.launchArguments}
          <div class="flex justify-between">
            <span class="text-gray-600">Arguments:</span>
            <span class="font-mono text-gray-800">{libraryInfo.launchArguments}</span>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
