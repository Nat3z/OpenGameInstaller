<script lang="ts">
  import type { LibraryInfo } from "ogi-addon";
  import { onDestroy, onMount } from "svelte";
  import PlayPage from "../components/PlayPage.svelte";
  import { gameFocused } from "../store";
  import { writable, type Writable } from "svelte/store";
  let library: LibraryInfo[] = $state([]);
  let selectedApp: Writable<LibraryInfo | undefined> = writable(undefined);
  let loading = $state(true);

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
    const apps = await window.electronAPI.app.getAllApps();

    if (window.electronAPI.fs.exists("./internals/apps.json")) {
      const appsOrdered: number[] = JSON.parse(
        window.electronAPI.fs.read("./internals/apps.json")
      );
      let libraryWithUndefined = appsOrdered.map(
        (id) => apps.find((app) => app.appID === id) ?? undefined
      );
      // get rid of undefined values and duplicate apps
      library = libraryWithUndefined.filter(
        (app) => app !== undefined
      ) as LibraryInfo[];
      library = library.filter(
        (app, index) =>
          library.findIndex((libApp) => libApp.appID === app.appID) === index
      );
      // see if other apps are not in the list, if so add them
      apps.forEach((app) => {
        if (!library.find((libApp) => libApp.appID === app.appID)) {
          console.log("Adding app to library: " + app.name);
          library.push(app);
        }
      });
    } else {
      library = apps;
    }
    loading = false;
  }
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
</script>

<div class="relative w-full h-full">
  {#if $selectedApp}
    <PlayPage libraryInfo={$selectedApp} {exitPlayPage} />
  {/if}
  <span
    class="flex flex-row p-4 gap-2 justify-start items-start w-full h-full relative"
  >
    {#await window.electronAPI.app.getOS()}
      <div></div>
    {:then os}
      {#if os === "win32"}
        {#each library as app}
          <button
            data-library-item
            class="flex border-none flex-col gap-2 transition-all shadow-md"
            onclick={() => ($selectedApp = app)}
          >
            <img
              src={app.capsuleImage}
              alt={app.name}
              class="w-44 h-64 rounded object-cover"
            />
          </button>
        {/each}
        {#if library.length === 0 && !loading}
          <div
            class="flex flex-col gap-2 w-full justify-center items-center h-full"
          >
            <img src="./favicon.png" alt="content" class="w-32 h-32" />
            <h1 class="text-2xl text-black">No games in library</h1>
          </div>
        {/if}
      {:else if os === "linux"}
        <div
          class="flex flex-col gap-2 w-full justify-center items-center h-full"
        >
          <img src="./favicon.png" alt="content" class="w-32 h-32" />
          <h1 class="text-2xl text-black">Library Unsupported</h1>
          <h1 class="text-lg text-gray-500 text-center">
            We're sorry, but library is currently unsupported for Linux. Use
            Steam + Proton to launch games, we already configure it for you!
          </h1>
        </div>
      {/if}
    {/await}
  </span>
</div>

<style>
  [data-library-item]:hover {
    /** make this pop up a bit, make it bigger */
    transform: scale(1.1);
    @apply drop-shadow-2xl shadow-2xl;
  }
</style>
