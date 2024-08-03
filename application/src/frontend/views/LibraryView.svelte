<script lang="ts">
  import type { LibraryInfo } from "ogi-addon";
  import { onMount } from "svelte";
  import PlayPage from "../components/PlayPage.svelte";
  let library: LibraryInfo[] = [];
  let selectedApp: LibraryInfo | undefined;
  export const exitPlayPage = () => {
    selectedApp = undefined;
    reloadLibrary();
  }
  async function reloadLibrary() {
    const apps = await window.electronAPI.app.getAllApps();
    
    if (window.electronAPI.fs.exists('./internals/apps.json')) {
      const appsOrdered: number[] = JSON.parse(window.electronAPI.fs.read('./internals/apps.json'));
      let libraryWithUndefined = appsOrdered.map((id) => apps.find((app) => app.steamAppID === id) ?? undefined);
      // get rid of undefined values and duplicate apps
      library = libraryWithUndefined.filter((app) => app !== undefined) as LibraryInfo[];
      library = library.filter((app, index) => library.findIndex((libApp) => libApp.steamAppID === app.steamAppID) === index);
      // see if other apps are not in the list, if so add them
      apps.forEach((app) => {
        if (!library.find((libApp) => libApp.steamAppID === app.steamAppID)) {
          console.log("Adding app to library: " + app.name);
          library.push(app);
        }
      });
    }
    else {
      library = apps;
    }
  }
  onMount(async () => {
    await reloadLibrary();
  });
</script>

<div class="relative w-full h-full">
  {#if selectedApp}
    <PlayPage appID={selectedApp.appID ?? selectedApp.steamAppID} libraryInfo={selectedApp} exitPlayPage={exitPlayPage} />
  {/if}
  <span class="flex flex-row p-4 gap-2 justify-start items-start w-full h-full relative">
    
    {#each library as app}
      <button data-library-item class="flex border-none flex-col gap-2 transition-all shadow-md" on:click={() => selectedApp = app}>
        <img src={app.capsuleImage} alt={app.name} class="w-44 h-64 rounded object-cover" />
      </button>
    {/each}
  </span>
</div>


<style>
  [data-library-item]:hover {
    /** make this pop up a bit, make it bigger */
    transform: scale(1.1);
    @apply drop-shadow-2xl shadow-2xl;
  }
</style>
