<script lang="ts">
  import type { LibraryInfo } from "ogi-addon";
  import PlayIcon from "../Icons/PlayIcon.svelte";

  export let appID: number;
  export let libraryInfo: LibraryInfo;
  async function doesLinkExist(url: string) {
    const response = await window.electronAPI.app.axios({
      method: 'get',
      url: url,
      headers: {
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });
    return response.status === 200;
  }
  async function launchGame() {
    console.log("Launching game with appID: " + appID);
    await window.electronAPI.app.launchGame("" + appID);
  }
</script>
<div class="flex flex-col top-0 left-0 absolute w-full h-full bg-white z-10 animate-fade-in" >
  <div class="relative flex justify-center items-center w-full">
    <img src={`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appID}/library_hero.jpg`} alt="header" class="w-full h-full" style="position: relative; z-index: 1;" />
    {#await doesLinkExist(`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appID}/logo_2x.png`)}
      <div class="absolute z-[2] w-full h-full"></div>
    {:then result}
      {#if result}
        <img src={`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appID}/logo_2x.png`} alt="logo" class="rounded absolute z-[2] w-2/4 h-1/4 drop-shadow-lg" style="top: 50%; left: 50%; transform: translate(-50%, -50%);" />
      {/if}
    {/await}
  </div>
  <div class="w-full bg-slate-200 p-4 flex-row flex justify-start items-center gap-8">
    <button class="px-8 py-4 flex border-none rounded-lg justify-center bg-green-500 items-center flex-row gap-2" on:click={() => launchGame()}>
      <PlayIcon fill="#86efac" />
      <p class="font-archivo font-semibold text-white">PLAY</p>
    </button>

    <div class="flex flex-col justify-center items-start">
      <p class="font-open-sans font-semibold text-gray-400 text-lg">PLAYTIME</p>
      <p class="font-open-sans font-semibold text-gray-500 text-sm">1 Hour</p>
    </div>
  </div>
</div>