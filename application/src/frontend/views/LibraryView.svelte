<script lang="ts">
  import type { LibraryInfo } from "ogi-addon";
  import { onMount } from "svelte";
  let library: LibraryInfo[] = [];
  onMount(async () => {
    library = await window.electronAPI.app.getAllApps();
  });
</script>
<span class="flex flex-row justify-start items-start w-full h-full">
  {#each library as app}
    <div class="flex flex-col p-4 gap-2 outline outline-red-500">
      <img src={app.capsuleImage} alt={app.name} class="w-44 h-64 rounded object-cover" />
      <p>{app.name}</p>
    </div>
  {/each}
</span>
