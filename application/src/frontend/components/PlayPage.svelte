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
  let openedGameConfiguration = $state(false);
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
<div
  class="flex flex-col top-0 left-0 absolute w-full h-full bg-white z-[2] animate-fade-in-pop-fast"
>
  <div class="relative flex justify-center items-center w-full">
    <img
      src={libraryInfo.coverImage}
      alt="header"
      class="w-full h-full"
      style="position: relative; z-index: 1;"
    />
    {#await doesLinkExist(libraryInfo.titleImage)}
      <div class="absolute z-[2] w-full h-full"></div>
    {:then result}
      {#if result}
        <img
          src={libraryInfo.titleImage}
          alt="logo"
          class="rounded p-32 pointer-events-none top-0 left-0 absolute z-[2] drop-shadow-lg"
          style="top: 50%; left: 50%; transform: translate(-50%, -50%);"
        />
      {/if}
    {/await}
  </div>
  <div
    class="w-full bg-slate-200 p-4 flex-row flex justify-start items-center gap-8"
  >
    <button
      bind:this={playButton}
      class="px-8 py-4 flex border-none rounded-lg justify-center bg-green-500 items-center flex-row gap-2 disabled:bg-yellow-500"
      onclick={() => launchGameTrigger.set(libraryInfo.appID)}
    >
      <PlayIcon fill="#86efac" />
      <p class="font-archivo font-semibold text-white">PLAY</p>
    </button>

    <!-- <div class="flex flex-col justify-center items-start">
      <p class="font-open-sans font-semibold text-gray-400 text-lg">PLAYTIME</p>
      <p class="font-open-sans font-semibold text-gray-500 text-sm">1 Hour</p>
    </div> -->

    <button
      class="px-4 ml-auto py-4 flex border-none rounded-lg justify-center bg-gray-500 items-center flex-row gap-2"
      onclick={openGameConfiguration}
    >
      <SettingsFilled fill="#e8eaed" />
    </button>
  </div>
  <div
    class="w-full flex-row bg-slate-200 p-4 py-2 flex justify-start items-center"
  >
    <button
      class="hover:bg-slate-400 border-none rounded-lg p-4 py-2"
      onclick={() => {
        currentStorePageOpened.set(libraryInfo.appID);
        currentStorePageOpenedSource.set(libraryInfo.addonsource);
        currentStorePageOpenedStorefront.set(libraryInfo.storefront);
      }}
    >
      <p class="font-archivo text-black">Store Page</p>
    </button>
  </div>
</div>
