<script lang="ts">
  import { onDestroy } from 'svelte';
  import DeleteAddonWarningModal from '../components/built/DeleteAddonWarningModal.svelte';
  import ButtonModal from '../components/modal/ButtonModal.svelte';
  import CloseModal from '../components/modal/CloseModal.svelte';
  import HeaderModal from '../components/modal/HeaderModal.svelte';
  import Modal from '../components/modal/Modal.svelte';
  import TextModal from '../components/modal/TextModal.svelte';
  import TitleModal from '../components/modal/TitleModal.svelte';
  import { type CommunityAddon, communityAddonsLocal } from '../store';
  import { fade } from 'svelte/transition';

  let communityList: CommunityAddon[] = $state([]);
  let currentAddons = $state(
    JSON.parse(window.electronAPI.fs.read('./config/option/general.json'))
  );
  let showWarningModal = $state(false);
  let selectedAddon: CommunityAddon | null = $state(null);
  let deleteConfirmationModalAddon: CommunityAddon | null = $state(null);

  async function installAddon(addon: CommunityAddon) {
    console.log('installing', addon);
    console.log(`Installing ${addon.name} by ${addon.author}`);

    if (!currentAddons.addons) {
      currentAddons.addons = [];
    }

    currentAddons = {
      ...currentAddons,
      addons: [...currentAddons.addons, addon.source],
    };

    console.log(currentAddons.addons);
    window.electronAPI.fs.write(
      './config/option/general.json',
      JSON.stringify(currentAddons, null, 2)
    );
    // remove proxy wrapping
    await window.electronAPI.installAddons(
      JSON.parse(JSON.stringify(currentAddons.addons))
    );
    setTimeout(async () => {
      await window.electronAPI.restartAddonServer();
    }, 2500);
  }

  async function deleteAddon(addon: CommunityAddon) {
    console.log(`Deleting ${addon.name} by ${addon.author}`);

    if (!currentAddons.addons) {
      currentAddons.addons = [];
    }
    currentAddons.addons = currentAddons.addons.filter(
      (source: string) => source !== addon.source
    );
    window.electronAPI.fs.write(
      './config/option/general.json',
      JSON.stringify(currentAddons, null, 2)
    );
    await window.electronAPI.restartAddonServer();
    // close the modal
    deleteConfirmationModalAddon = null;
  }

  async function deleteAddonWarning(addon: CommunityAddon) {
    deleteConfirmationModalAddon = addon;
  }

  function openWarningModal(addon: CommunityAddon) {
    selectedAddon = addon;
    showWarningModal = true;
  }

  function closeWarningModal() {
    showWarningModal = false;
    selectedAddon = null;
  }

  async function proceedWithInstall(addon: CommunityAddon) {
    if (addon) {
      closeWarningModal();
      await installAddon(addon);
    }
  }
  const unsub = communityAddonsLocal.subscribe((addons) => {
    communityList = addons;
  });
  onDestroy(() => {
    unsub();
  });
</script>

{#if deleteConfirmationModalAddon}
  <DeleteAddonWarningModal
    open={deleteConfirmationModalAddon !== null}
    onClose={() => (deleteConfirmationModalAddon = null)}
    deleteAddonGO={() => deleteAddon(deleteConfirmationModalAddon!)}
    addonName={deleteConfirmationModalAddon?.name || ''}
  />
{/if}

<div class="community-addons">
  {#if communityList.length === 0}
    <div class="loading-container">
      <div class="loading-message" in:fade={{ duration: 300 }}>
        <div class="loading-spinner"></div>
        <p class="text-lg">Loading community addons...</p>
      </div>
    </div>
  {:else}
    <div class="addon-grid">
      {#if showWarningModal && selectedAddon}
        <Modal
          open={showWarningModal}
          size="medium"
          onClose={closeWarningModal}
        >
          <CloseModal />
          <TitleModal title="Community Addon" />
          <HeaderModal header="You are about to download an addon from:" />
          <TextModal
            text={selectedAddon.source}
            variant="caption"
            class="mb-4 break-all"
          />
          <TextModal
            text="Warning: This is a community addon and is not officially authorized for use. Proceed at your own risk."
            variant="warning"
            class="mb-4 text-red-600"
          />
          <TextModal
            text="All content downloaded from this addon is the responsibility of the user."
            variant="warning"
            class="mb-6 text-red-600"
          />
          <div class="flex gap-4 justify-end mt-auto">
            <ButtonModal
              text="Cancel"
              variant="secondary"
              onclick={closeWarningModal}
            />
            <ButtonModal
              text="Proceed"
              variant="danger"
              onclick={() => proceedWithInstall(selectedAddon!)}
            />
          </div>
        </Modal>
      {/if}
      {#each communityList as addon}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="flex flex-row items-center justify-start hover:cursor-pointer"
          onclick={() =>
            currentAddons.addons && currentAddons.addons.includes(addon.source)
              ? deleteAddonWarning(addon)
              : openWarningModal(addon)}
        >
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
                onclick={() => deleteAddonWarning(addon)}
                id={`delete-addon-${addon.source}`}
                class="action-button delete-button"
                aria-label="Uninstall addon"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="w-10 h-10 text-accent-dark"
                  fill="currentColor"
                  enable-background="new 0 0 24 24"
                  height="24"
                  viewBox="0 0 24 24"
                  width="24"
                  ><g><path d="M0,0h24v24H0V0z" fill="none" /></g><g
                    ><path
                      d="M6,19c0,1.1,0.9,2,2,2h8c1.1,0,2-0.9,2-2V7H6V19z M9.17,12.59c-0.39-0.39-0.39-1.02,0-1.41c0.39-0.39,1.02-0.39,1.41,0 L12,12.59l1.41-1.41c0.39-0.39,1.02-0.39,1.41,0s0.39,1.02,0,1.41L13.41,14l1.41,1.41c0.39,0.39,0.39,1.02,0,1.41 s-1.02,0.39-1.41,0L12,15.41l-1.41,1.41c-0.39,0.39-1.02,0.39-1.41,0c-0.39-0.39-0.39-1.02,0-1.41L10.59,14L9.17,12.59z M18,4h-2.5 l-0.71-0.71C14.61,3.11,14.35,3,14.09,3H9.91c-0.26,0-0.52,0.11-0.7,0.29L8.5,4H6C5.45,4,5,4.45,5,5s0.45,1,1,1h12 c0.55,0,1-0.45,1-1S18.55,4,18,4z"
                    /></g
                  ></svg
                >
              </button>
            {:else}
              <button
                onclick={() => openWarningModal(addon)}
                class="action-button install-button"
                aria-label="Install addon"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="w-10 h-10 text-accent-dark"
                  height="24px"
                  viewBox="0 -960 960 960"
                  width="24px"
                  fill="currentColor"
                >
                  <path
                    d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"
                  />
                </svg>
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
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
