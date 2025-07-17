<script lang="ts">
  import ButtonModal from "../components/modal/ButtonModal.svelte";
  import CloseModal from "../components/modal/CloseModal.svelte";
  import HeaderModal from "../components/modal/HeaderModal.svelte";
  import Modal from "../components/modal/Modal.svelte";
  import TextModal from "../components/modal/TextModal.svelte";
  import TitleModal from "../components/modal/TitleModal.svelte";

  type CommunityAddon = {
    name: string;
    author: string;
    source: string;
    img: string;
    description: string;
  }
  let communityList = new Promise<CommunityAddon[]>((resolve) => fetch('https://ogi.nat3z.com/api/community.json').then((response) => response.json()).then((data) => resolve(data)));
  let currentAddons = $state(JSON.parse(window.electronAPI.fs.read('./config/option/general.json')));
  let showWarningModal = $state(false);
  let selectedAddon: CommunityAddon | null = $state(null);
  let pendingEvent: MouseEvent | null = $state(null);

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
    currentTarget.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>';
    currentTarget.disabled = true;
    currentTarget.classList.remove('bg-accent-dark', 'hover:bg-accent-light');
    currentTarget.classList.add('bg-green-600', 'cursor-not-allowed');
    await window.electronAPI.installAddons(currentAddons.addons);
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

  function openWarningModal(addon: CommunityAddon, event: MouseEvent) {
    selectedAddon = addon;
    pendingEvent = event;
    showWarningModal = true;
  }

  function closeWarningModal() {
    showWarningModal = false;
    selectedAddon = null;
    pendingEvent = null;
  }

  async function proceedWithInstall() {
    if (selectedAddon && pendingEvent) {
      await installAddon(selectedAddon, pendingEvent);
      closeWarningModal();
    }
  }
</script>

<div class="community-addons">
  {#await communityList}
    <div class="loading-container">
      <p class="loading-text">Loading community addons...</p>
    </div>
  {:then communityList}
    <div class="addon-grid">
      {#if showWarningModal && selectedAddon}
        <Modal open={showWarningModal} size="medium" onClose={closeWarningModal}>
          <CloseModal onClose={closeWarningModal} />
          <TitleModal title="Community Addon" />
          <HeaderModal header="You are about to download an addon from:" />
          <TextModal text={selectedAddon.source} variant="caption" class="mb-4 break-all" />
          <TextModal text="Warning: This is a community addon and is not officially authorized for use. Proceed at your own risk." variant="warning" class="mb-4 text-red-600" />
          <TextModal text="All content downloaded from this addon is the responsibility of the user." variant="warning" class="mb-6 text-red-600" />
          <div class="flex gap-4 justify-end mt-auto">
            <ButtonModal text="Cancel" variant="secondary" on:click={closeWarningModal} />
            <ButtonModal text="Proceed" variant="danger" on:click={proceedWithInstall} />
          </div>
        </Modal>
      {/if}
      {#each communityList as addon}
        <div class="flex flex-row items-center justify-start">
          <div class="addon-card">
            <div class="addon-content">
              <div class="addon-icon">
                <img src={addon.img} alt={addon.name} />
              </div>
              <div class="addon-info">
                <h2 class="addon-title">{addon.name}</h2>
                <p class="addon-description">{addon.description}</p>
              </div>
            </div> 
          </div>
          <div class="addon-actions">
            {#if currentAddons.addons && currentAddons.addons.includes(addon.source)}
              <button 
                onclick={() => deleteAddon(addon)} 
                class="action-button delete-button"
                aria-label="Uninstall addon"
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-accent-dark" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
                  <path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/>
                </svg>
              </button>
            {:else}
              <button 
                onclick={(ev) => openWarningModal(addon, ev)} 
                class="action-button install-button"
                aria-label="Install addon"
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-accent-dark" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
                  <path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"/>
                </svg>
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:catch}
    <div class="error-container">
      <p class="error-text">Failed to load community addons. Please try again later.</p>
    </div>
  {/await}
</div>

<style>
  .community-addons {
    @apply flex flex-col w-full h-full;
  }
  
  .loading-container,
  .error-container {
    @apply flex items-center justify-center w-full h-full;
  }
  
  .loading-text,
  .error-text {
    @apply text-lg text-gray-600;
  }
  
  .addon-grid {
    @apply flex flex-col w-full gap-4 py-6 px-0 overflow-y-auto;
    max-height: calc(100vh - 200px);
  }
  
  .addon-card {
    @apply bg-accent-lighter rounded-lg h-28 flex items-center justify-between;
    width: 100%;
  }
  
  .addon-content {
    @apply flex items-center h-full w-full;
  }
  
  .addon-icon {
    @apply flex items-center justify-center flex-shrink-0;
    width: 100px;
    height: 100px;
  }
  
  .addon-icon img {
    @apply w-[64px] h-[64px] object-cover rounded-lg;
  }
  
  .addon-info {
    @apply flex flex-col justify-center flex-1 ml-6;
  }
  
  .addon-title {
    @apply text-2xl font-semibold text-gray-900 mb-2;
  }
  
  .addon-description {
    @apply text-lg text-gray-600 leading-relaxed;
  }
  
  .addon-actions {
    @apply flex items-center justify-center mr-4 ml-8 flex-shrink-0;
    width: 70px;
    height: 70px;
  }
  
  .action-button {
    @apply w-full h-full flex items-center justify-center border-none outline-none cursor-pointer bg-transparent hover:bg-gray-100 rounded-2xl transition-colors duration-200;
  }
  
  
  .action-button:disabled {
    @apply cursor-not-allowed opacity-75;
  }
</style>
