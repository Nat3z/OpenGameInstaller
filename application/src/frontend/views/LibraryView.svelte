<script lang="ts">
  import type { LibraryInfo } from "ogi-addon";
  import { onMount } from "svelte";
  import PlayPage from "../components/PlayPage.svelte";
  let library: LibraryInfo[] = [];
  let selectedApp: LibraryInfo;

  onMount(async () => {
    library = await window.electronAPI.app.getAllApps();
  });
</script>

<div class="relative w-full h-full">
  {#if selectedApp}
    <PlayPage appID={selectedApp.steamAppID} libraryInfo={selectedApp} />
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
