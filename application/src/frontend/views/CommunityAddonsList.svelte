<script lang="ts">
  type CommunityAddon = {
    name: string;
    author: string;
    source: string;
    img: string;
    description: string;
  }
  let communityList = new Promise<CommunityAddon[]>((resolve) => fetch('https://ogi.nat3z.com/api/community.json').then((response) => response.json()).then((data) => resolve(data)));
  let currentAddons = $state(JSON.parse(window.electronAPI.fs.read('./config/option/general.json')));

  async function installAddon(addon: CommunityAddon, event: MouseEvent) {
    console.log(`Installing ${addon.name} by ${addon.author}`);

    if (!currentAddons.addons) {
      currentAddons.addons = [];
    }

    currentAddons = {
      ...currentAddons,
      addons: [
        ...currentAddons.addons,
        addon.source
      ]
    };
    window.electronAPI.fs.write('./config/option/general.json', JSON.stringify(currentAddons, null, 2));
    const currentTarget = event.target as HTMLButtonElement;
    currentTarget.innerText = 'Installing...';
    currentTarget.disabled = true;
    await window.electronAPI.installAddons(currentAddons.addons);
    currentTarget.innerText = 'Installed';
    currentTarget.disabled = true;
    currentTarget.classList.remove('bg-blue-200');
    currentTarget.classList.add('bg-green-200');
    await window.electronAPI.restartAddonServer();
  }

  async function deleteAddon(addon: CommunityAddon) {
    console.log(`Deleting ${addon.name} by ${addon.author}`);

    if (!currentAddons.addons) {
      currentAddons.addons = [];
    }
    currentAddons.addons = currentAddons.addons.filter((source: string) => source !== addon.source);
    window.electronAPI.fs.write('./config/option/general.json', JSON.stringify(currentAddons, null, 2));
    await window.electronAPI.restartAddonServer();
  }
</script>

{#await communityList}
  <p>Loading...</p>
{:then communityList}
  <p class="px-6 py-2 text-gray-300 text-xs">Community addons are not affiliated with OpenGameInstaller. This is a community listing and anyone can add to this list.</p>
  <div class="flex flex-col gap-4 w-full lg:w-3/4 justify-center px-4 lg:px-0 items-center">
    {#each communityList as addon}
      <div class="flex flex-col gap-2 border-2 rounded-lg p-8 w-full lg:w-3/4">
        <div class="flex flex-row gap-4 items-center relative">
          <img src={addon.img} alt={addon.name} class="w-16 h-16 rounded-lg" />
          <div class="flex flex-col relative">
            <h2 class="text-2xl font-bold">{addon.name}</h2>
            <h3 data-source class="p-1 px-2 rounded-lg border text-xs w-fit text-balance lg:text-sm lg:w-full bg-slate-200 truncate transition-all">{addon.source}</h3>
          </div>
        </div>
        <div class="flex flex-row gap-2">
          {#if currentAddons.addons.includes(addon.source)}
            <button disabled class="w-fit px-4 rounded-md bg-green-200 border-transparent">Installed</button>
            <button onclick={() => deleteAddon(addon)} class="flex justify-center items-center w-fit px-1 rounded-md bg-red-200 border-transparent">
              <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="black"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>
            </button>
          {:else}
            <button onclick={(ev) => installAddon(addon, ev)} class="w-fit px-4 rounded-md bg-blue-200 border-transparent">Install</button>
          {/if}
        </div>

        <div>
          {addon.description}
        </div>
    </div>
  {/each}
  </div> 
{/await}
