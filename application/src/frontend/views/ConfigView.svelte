<script lang="ts">
import type {
  ConfigurationFile,
  OGIAddonConfiguration,
} from '@ogi-sdk/connect';
import { onDestroy, onMount } from 'svelte';
import { quintOut } from 'svelte/easing';
import { writable } from 'svelte/store';
import { fly } from 'svelte/transition';
import AddonPicture from '@/frontend/components/AddonPicture.svelte';
import ButtonModal from '@/frontend/components/modal/ButtonModal.svelte';
import CloseModal from '@/frontend/components/modal/CloseModal.svelte';
import HeaderModal from '@/frontend/components/modal/HeaderModal.svelte';
import InputModal from '@/frontend/components/modal/InputModal.svelte';
import Modal from '@/frontend/components/modal/Modal.svelte';
import SectionModal from '@/frontend/components/modal/SectionModal.svelte';
import TextModal from '@/frontend/components/modal/TextModal.svelte';
import TitleModal from '@/frontend/components/modal/TitleModal.svelte';
import {
  addonUpdates,
  createNotification,
  DEFAULT_MARKETPLACE_SOURCES,
  fetchCommunityAddons,
  loadMarketplaceSources,
  marketplaceSources,
  saveMarketplaceSources,
} from '@/frontend/store.svelte';
import { queryConnectedAddons, reconnectClientSdk } from '@/frontend/utils';
import CommunityAddonsList from '@/frontend/views/CommunityAddonsList.svelte';
import FocusedAddonView from '@/frontend/views/FocusedAddonView.svelte';

let addons: ConfigTemplateAndInfo[] = $state([]);
let communityAddonsInfo: boolean = $state(false);
let showAddonAddModal: boolean = $state(false);
let showMarketplaceSourceModal: boolean = $state(false);
let addonUrl: string = $state('');
let marketplaceSourceUrl: string = $state('');
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let view = writable<'my-addons' | 'community-addons'>('my-addons');

onMount(() => {
  // Initial fetch
  queryConnectedAddons<ConfigTemplateAndInfo>()
    .then((data) => {
      addons = data;
    })
    .catch((error) =>
      console.error('Failed to query connected addons:', error)
    );
  // Start polling every 3 seconds
  pollingInterval = setInterval(() => {
    queryConnectedAddons<ConfigTemplateAndInfo>()
      .then((data) => {
        addons = data;
      })
      .catch((error) =>
        console.error('Failed to query connected addons:', error)
      );
  }, 3000);
});
interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
  configTemplate: ConfigurationFile;
}

onDestroy(() => {
  if (pollingInterval) clearInterval(pollingInterval);
});

let focusedAddonId: string | null = $state(null);

function openAddonSettings(addonId: string) {
  focusedAddonId = addonId;
}

function goBackToList() {
  focusedAddonId = null;
}

async function updateAddons() {
  const buttonsToDisable = document.querySelectorAll('[data-disable]');
  buttonsToDisable.forEach((button) => {
    button.setAttribute('disabled', 'true');
  });

  try {
    await window.electronAPI.updateAddons();
    addonUpdates.set([]);
    await window.electronAPI.restartAddonServer();
    await reconnectClientSdk();
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: 'Addons updated successfully',
      type: 'success',
    });
  } catch (error) {
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: 'Failed to update addons',
      type: 'error',
    });
  } finally {
    buttonsToDisable.forEach((button) => {
      button.removeAttribute('disabled');
    });
  }
}

async function addAddon() {
  showAddonAddModal = false;

  createNotification({
    id: Math.random().toString(36).substring(7),
    message: 'Installing addon...',
    type: 'info',
  });
  await window.electronAPI.installAddons([addonUrl]);
  addonUrl = '';
  await reconnectClientSdk();
}

function openMarketplaceSourceManager() {
  loadMarketplaceSources();
  marketplaceSourceUrl = '';
  showMarketplaceSourceModal = true;
}

async function refreshMarketplaceSources(sources: string[]) {
  saveMarketplaceSources(sources);
  await fetchCommunityAddons();
}

async function addMarketplaceSource() {
  const source = marketplaceSourceUrl.trim();
  if (!source) return;

  try {
    new URL(source);
  } catch {
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: 'Please enter a valid marketplace URL',
      type: 'error',
    });
    return;
  }

  await refreshMarketplaceSources([...marketplaceSources, source]);
  marketplaceSourceUrl = '';
}

async function removeMarketplaceSource(source: string) {
  await refreshMarketplaceSources(
    marketplaceSources.filter(
      (marketplaceSource) => marketplaceSource !== source
    )
  );
}

async function resetMarketplaceSources() {
  await refreshMarketplaceSources([...DEFAULT_MARKETPLACE_SOURCES]);
}
</script>

<div
  class="flex flex-col overflow-y-auto justify-start overflow-x-hidden items-start w-full h-full relative"
>
  {#if focusedAddonId}
    <div
      class="absolute inset-0 w-full h-full z-10"
      in:fly={{ x: 100, duration: 400, easing: quintOut }}
      out:fly={{ x: -100, duration: 300 }}
    >
      <FocusedAddonView
        addonId={focusedAddonId}
        onBack={goBackToList}
        refreshAddon={() => {
          /* no-op, polling handles refresh */
        }}
      />
    </div>
  {/if}

  {#if !focusedAddonId}
    <div
      class="relative w-full h-16 bg-background-color z-10"
      out:fly={{ y: -100, duration: 400, easing: quintOut }}
      in:fly={{ y: -100, duration: 400, easing: quintOut }}
    >
      <div class="absolute inset-0 flex flex-row gap-4 h-12 z-10">
        <button
          data-selected={$view === 'my-addons'}
          onclick={() => view.set('my-addons')}
          class="h-full flex-1 border-none text-accent-dark font-archivo rounded-lg bg-accent-lighter data-[selected=true]:bg-accent-light shadow-md text-lg hover:bg-accent-light transition-colors"
          >My Addons</button
        >
        <button
          data-selected={$view === 'community-addons'}
          onclick={() => view.set('community-addons')}
          class="h-full flex-1 border-none text-accent-dark rounded-lg bg-accent-lighter shadow-md data-[selected=true]:bg-accent-light font-archivo text-lg hover:bg-accent-light transition-colors"
          >Community Addons</button
        >
        {#if $view === 'community-addons'}
          <div class="flex justify-center items-center gap-2 shrink-0">
            <button
              class="bg-accent-lighter h-full text-accent-dark px-4 py-3 rounded-lg font-archivo font-semibold hover:bg-accent-light transition-colors border-none shadow-md flex items-center gap-2"
              onclick={openMarketplaceSourceManager}
              data-disable
              aria-label="Manage Marketplace Sources"
              title="Manage Marketplace Sources"
              in:fly={{ y: -100, duration: 400, easing: quintOut }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="currentColor"
                height="24"
                viewBox="0 0 24 24"
                width="24"
                ><path d="M0 0h24v24H0z" fill="none" /><path
                  d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"
                /></svg
              >
            </button>
            <button
              class="bg-accent-lighter h-full text-accent-dark px-4 py-3 rounded-lg font-archivo font-semibold hover:bg-accent-light transition-colors border-none shadow-md flex items-center gap-2"
              onclick={() => (communityAddonsInfo = true)}
              data-disable
              aria-label="Info About Community Addons"
              in:fly={{ y: -100, duration: 400, easing: quintOut }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="currentColor"
                height="24"
                viewBox="0 0 24 24"
                width="24"
                ><path d="M0 0h24v24H0V0z" fill="none" /><path
                  d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 15c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1s1 .45 1 1v4c0 .55-.45 1-1 1zm1-8h-2V7h2v2z"
                /></svg
              >
            </button>
          </div>
        {:else if $view === 'my-addons'}
          <button
            class="bg-accent-lighter z-10 text-accent-dark h-full px-6 relative py-3 rounded-lg font-archivo font-semibold hover:bg-accent-light transition-colors border-none shadow-md flex items-center gap-2"
            onclick={() => updateAddons()}
            data-disable
            aria-label="Update all addons"
            in:fly={{ y: -100, duration: 400, easing: quintOut }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="w-5 h-5"
              fill="currentColor"
              enable-background="new 0 0 24 24"
              height="24"
              viewBox="0 0 24 24"
              width="24"
              ><g><rect fill="none" height="24" width="24" /></g><g
                ><g
                  ><path
                    d="M11,8.75v3.68c0,0.35,0.19,0.68,0.49,0.86l3.12,1.85c0.36,0.21,0.82,0.09,1.03-0.26c0.21-0.36,0.1-0.82-0.26-1.03 l-2.87-1.71v-3.4C12.5,8.34,12.16,8,11.75,8S11,8.34,11,8.75z M21,9.5V4.21c0-0.45-0.54-0.67-0.85-0.35l-1.78,1.78 c-1.81-1.81-4.39-2.85-7.21-2.6c-4.19,0.38-7.64,3.75-8.1,7.94C2.46,16.4,6.69,21,12,21c4.59,0,8.38-3.44,8.93-7.88 c0.07-0.6-0.4-1.12-1-1.12c-0.5,0-0.92,0.37-0.98,0.86c-0.43,3.49-3.44,6.19-7.05,6.14c-3.71-0.05-6.84-3.18-6.9-6.9 C4.94,8.2,8.11,5,12,5c1.93,0,3.68,0.79,4.95,2.05l-2.09,2.09C14.54,9.46,14.76,10,15.21,10h5.29C20.78,10,21,9.78,21,9.5z"
                  /></g
                ></g
              ></svg
            >
            {#if $addonUpdates.length > 0}
              <div
                class="absolute -bottom-1 -right-1 bg-yellow-500 rounded-full w-4 h-4 animate-pulse"
              ></div>
            {/if}
          </button>
          <button
            class="bg-accent-lighter z-10 text-accent-dark h-full px-6 relative py-3 rounded-lg font-archivo font-semibold hover:bg-accent-light transition-colors border-none shadow-md flex items-center gap-2"
            in:fly={{ y: -100, duration: 400, easing: quintOut }}
            aria-label="Add Addon"
            onclick={() => (showAddonAddModal = true)}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
              class="w-5 h-5"
              width="24"
              ><path d="M0 0h24v24H0V0z" fill="none" /><path
                d="M18 13h-5v5c0 .55-.45 1-1 1s-1-.45-1-1v-5H6c-.55 0-1-.45-1-1s.45-1 1-1h5V6c0-.55.45-1 1-1s1 .45 1 1v5h5c.55 0 1 .45 1 1s-.45 1-1 1z"
              /></svg
            >
          </button>
        {/if}
      </div>
    </div>

    <div
      class="w-full h-full relative"
      in:fly={{ x: -100, duration: 400, easing: quintOut }}
      out:fly={{ x: 100, duration: 300 }}
    >
      {#if $view === 'my-addons'}
        <div
          class="config absolute inset-0"
          in:fly={{ x: -100, duration: 400, easing: quintOut }}
          out:fly={{ x: 100, duration: 300 }}
        >
          <div class="addon-list">
            {#if addons.length !== 0}
              {#each addons as addon}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <section
                  class="addon-card-large hover:cursor-pointer"
                  onkeypress={() => {}}
                  onclick={() => openAddonSettings(addon.id)}
                  id={'cfg-' + addon.id}
                >
                  <div class="addon-card-content">
                    <div class="addon-icon-container relative">
                      <AddonPicture
                        addonId={addon.id}
                        class="w-16 h-16 rounded-lg"
                      />
                      {#if $addonUpdates
                        .map((update) => update.toLowerCase())
                        .includes(addon.repository.toLowerCase())}
                        <div
                          class="absolute -bottom-1 -right-1 bg-yellow-500 rounded-full w-4 h-4 animate-pulse"
                        ></div>
                      {/if}
                    </div>
                    <div class="addon-info">
                      <h2 class="addon-title">{addon.name}</h2>
                      <p class="addon-description">{addon.description}</p>
                    </div>
                  </div>
                  <div class="addon-settings">
                    <button
                      class="settings-button outline-none border-none text-accent-dark"
                      aria-label="Open settings"
                      onclick={() => openAddonSettings(addon.id)}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        class="w-10 h-10"
                        fill="currentColor"
                        enable-background="new 0 0 24 24"
                        height="24"
                        viewBox="0 0 24 24"
                        width="24"
                        ><rect fill="none" height="24" width="24" /><path
                          d="M19.5,12c0-0.23-0.01-0.45-0.03-0.68l1.86-1.41c0.4-0.3,0.51-0.86,0.26-1.3l-1.87-3.23c-0.25-0.44-0.79-0.62-1.25-0.42 l-2.15,0.91c-0.37-0.26-0.76-0.49-1.17-0.68l-0.29-2.31C14.8,2.38,14.37,2,13.87,2h-3.73C9.63,2,9.2,2.38,9.14,2.88L8.85,5.19 c-0.41,0.19-0.8,0.42-1.17,0.68L5.53,4.96c-0.46-0.2-1-0.02-1.25,0.42L2.41,8.62c-0.25,0.44-0.14,0.99,0.26,1.3l1.86,1.41 C4.51,11.55,4.5,11.77,4.5,12s0.01,0.45,0.03,0.68l-1.86,1.41c-0.4,0.3-0.51,0.86-0.26,1.3l1.87,3.23c0.25,0.44,0.79,0.62,1.25,0.42 l2.15-0.91c0.37,0.26,0.76,0.49,1.17,0.68l0.29,2.31C9.2,21.62,9.63,22,10.13,22h3.73c0.5,0,0.93-0.38,0.99-0.88l0.29-2.31 c0.41-0.19,0.8-0.42,1.17-0.68l2.15,0.91c0.46,0.2,1,0.02,1.25-0.42l1.87-3.23c0.25-0.44,0.14-0.99-0.26-1.3l-1.86-1.41 C19.49,12.45,19.5,12.23,19.5,12z M12.04,15.5c-1.93,0-3.5-1.57-3.5-3.5s1.57-3.5,3.5-3.5s3.5,1.57,3.5,3.5S13.97,15.5,12.04,15.5z"
                        /></svg
                      >
                    </button>
                  </div>
                </section>
              {/each}
            {/if}
          </div>
        </div>
      {:else if $view === 'community-addons'}
        <div
          class="w-full h-full absolute inset-0"
          in:fly={{ x: 100, duration: 400, easing: quintOut }}
          out:fly={{ x: -100, duration: 300 }}
        >
          <CommunityAddonsList />
        </div>
      {/if}
    </div>
  {/if}
</div>
{#if communityAddonsInfo}
  <Modal
    size="medium"
    open={communityAddonsInfo}
    onClose={() => (communityAddonsInfo = false)}
    closeOnOverlayClick={true}
  >
    <TitleModal title="Community Addons" />
    <CloseModal />
    <HeaderModal header="What are Community Addons?" />
    <SectionModal>
      <TextModal
        text="Community Addons are addons that are not officially supported by the OGI team."
        variant="body"
      />
      <TextModal
        text="They are provided as a convenience for download to the community."
        variant="body"
      />
    </SectionModal>
    <TextModal
      text="Please use them at your own risk. All content downloaded from addons are the responsibility of you (the user)."
      variant="warning"
    />

    <TextModal text="Sourced from: https://ogi.nat3z.com/" variant="caption" />
    <ButtonModal
      text="Close"
      onclick={() => (communityAddonsInfo = false)}
      class="mt-4"
      variant="primary"
    />
  </Modal>
{/if}

{#if showMarketplaceSourceModal}
  <Modal
    size="large"
    class="marketplace-source-modal"
    open={showMarketplaceSourceModal}
    onClose={() => (showMarketplaceSourceModal = false)}
  >
    <CloseModal />
    <div class="marketplace-modal-shell">
      <div class="marketplace-modal-header">
        <div>
          <h2 class="marketplace-modal-title">Marketplace Sources</h2>
          <p class="marketplace-modal-description">
            Choose which marketplace URLs are used to populate the Community
            Addons list.
          </p>
        </div>
      </div>

      <div class="marketplace-add-row">
        <label class="marketplace-input-label" for="marketplace-source-url">
          Add source URL
        </label>
        <div class="marketplace-input-row">
          <input
            id="marketplace-source-url"
            class="marketplace-input"
            type="url"
            bind:value={marketplaceSourceUrl}
            placeholder="https://ogi-marketplace.nat3z.com"
            onkeydown={(event) => {
              if (event.key === 'Enter') addMarketplaceSource();
            }}
          />
          <button class="marketplace-add-button" onclick={addMarketplaceSource}>
            Add
          </button>
        </div>
        <p class="marketplace-input-help">
          Base URLs and direct <code>/api/marketplace.json</code> links are both supported.
        </p>
      </div>

      <div class="marketplace-source-section">
        <div class="marketplace-source-heading">
          <span>Active sources</span>
          <span class="marketplace-source-count"
            >{marketplaceSources.length}</span
          >
        </div>

        <div class="marketplace-source-list">
          {#each marketplaceSources as source}
            <div class="marketplace-source-item">
              <div class="marketplace-source-icon" aria-hidden="true">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M0 0h24v24H0z" fill="none" />
                  <path
                    d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"
                  />
                </svg>
              </div>
              <div class="marketplace-source-copy">
                <span class="marketplace-source-url">{source}</span>
              </div>
              <button
                class="marketplace-remove-button"
                aria-label={`Remove marketplace source ${source}`}
                onclick={() => removeMarketplaceSource(source)}
              >
                Remove
              </button>
            </div>
          {/each}
        </div>
      </div>

      <div class="marketplace-modal-actions">
        <button
          class="marketplace-secondary-button"
          onclick={resetMarketplaceSources}
        >
          Reset default
        </button>
        <button
          class="marketplace-primary-button"
          onclick={() => (showMarketplaceSourceModal = false)}
        >
          Done
        </button>
      </div>
    </div>
  </Modal>
{/if}

{#if showAddonAddModal}
  <Modal
    size="medium"
    open={showAddonAddModal}
    onClose={() => (showAddonAddModal = false)}
  >
    <TitleModal title="Add Addon" />
    <CloseModal />

    <InputModal
      id="addon-url"
      label="Addon URL"
      description="The URL of the addon to add."
      type="text"
      class="mb-8 mt-4"
      onchange={(_, value) => {
        addonUrl = value as string;
      }}
    />
    <div class="flex flex-row gap-4">
      <ButtonModal
        text="Close"
        onclick={() => (showAddonAddModal = false)}
        variant="secondary"
      />
      <ButtonModal
        text="Add Addon"
        variant="primary"
        onclick={() => addAddon()}
      />
    </div>
  </Modal>
{/if}

<style>
  @reference "../app.css";

  .config {
    @apply flex flex-col w-full h-full;
  }

  .addon-list {
    @apply flex flex-col w-full gap-4 py-6 px-0 overflow-y-auto;
    max-height: calc(100vh - 200px);
  }

  .addon-card-large {
    @apply rounded-lg h-28 duration-200 flex flex-row items-center relative;
    width: 100%;
  }

  .addon-card-content {
    @apply flex items-center justify-between h-full w-full bg-accent-lighter rounded-lg p-4;
  }

  .addon-icon-container {
    @apply flex items-center justify-center w-16 h-16 relative z-10;
    flex-shrink: 0;
  }

  .addon-info {
    @apply flex flex-col justify-center flex-1 ml-6 relative z-10;
  }

  .addon-title {
    @apply text-2xl font-semibold text-text-primary mb-2;
  }

  .addon-description {
    @apply text-lg text-text-secondary leading-relaxed;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
  }

  .addon-settings {
    @apply flex items-center justify-center mr-4 ml-8 flex-shrink-0;
    width: 70px;
    height: 70px;
  }

  .settings-button {
    @apply w-full h-full flex items-center justify-center bg-transparent hover:bg-bg-secondary rounded-2xl transition-colors duration-200;
  }

  :global(.marketplace-source-modal) {
    width: min(42rem, calc(100vw - 2rem));
    max-height: min(42rem, calc(100vh - 2rem));
    overflow: hidden !important;
    padding: 0 !important;
  }

  .marketplace-modal-shell {
    @apply flex flex-col gap-5 w-full h-full p-6;
    max-height: min(42rem, calc(100vh - 2rem));
  }

  .marketplace-modal-header {
    @apply pr-8 pb-4 border-b border-accent-light;
  }

  .marketplace-modal-eyebrow {
    @apply text-xs uppercase tracking-widest font-archivo font-bold text-accent-dark mb-1;
  }

  .marketplace-modal-title {
    @apply text-3xl font-archivo font-bold text-text-primary m-0;
  }

  .marketplace-modal-description {
    @apply text-sm text-text-secondary mt-2 leading-relaxed max-w-xl;
  }

  .marketplace-add-row {
    @apply rounded-xl border border-accent-light bg-surface p-4;
  }

  .marketplace-input-label {
    @apply block text-sm font-archivo font-bold text-text-primary mb-2;
  }

  .marketplace-input-row {
    @apply flex gap-2;
  }

  .marketplace-input {
    @apply min-w-0 flex-1 rounded-lg border border-border bg-input-bg px-3 py-2 text-text-primary outline-none transition-colors;
  }

  .marketplace-input:focus {
    @apply border-accent ring-2 ring-focus-ring;
  }

  .marketplace-input-help {
    @apply text-xs text-text-muted mt-2;
  }

  .marketplace-input-help code {
    @apply rounded bg-accent-lighter px-1 py-0.5 text-accent-dark;
  }

  .marketplace-add-button,
  .marketplace-primary-button,
  .marketplace-secondary-button,
  .marketplace-remove-button {
    @apply rounded-lg border-none font-archivo font-semibold transition-colors cursor-pointer;
  }

  .marketplace-add-button {
    @apply bg-accent text-overlay-text px-4 py-2 hover:bg-accent-dark;
  }

  .marketplace-source-section {
    @apply flex min-h-0 flex-1 flex-col gap-3;
  }

  .marketplace-source-heading {
    @apply flex items-center justify-between text-sm font-archivo font-bold text-text-primary;
  }

  .marketplace-source-count {
    @apply rounded-uniform bg-accent-lighter px-2 py-0.5 text-xs text-accent-dark;
  }

  .marketplace-source-list {
    @apply flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1;
  }

  .marketplace-source-item {
    @apply flex items-center gap-3 rounded-xl border border-border bg-bg-secondary p-3;
  }

  .marketplace-source-icon {
    @apply flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-lighter text-accent-dark;
  }

  .marketplace-source-icon svg {
    @apply h-5 w-5;
  }

  .marketplace-source-copy {
    @apply min-w-0 flex-1;
  }

  .marketplace-source-url {
    @apply block truncate text-sm font-medium text-text-primary;
  }

  .marketplace-remove-button {
    @apply shrink-0 bg-transparent px-3 py-1.5 text-sm text-error hover:bg-error/10;
  }

  .marketplace-modal-actions {
    @apply flex shrink-0 justify-end gap-3 border-t border-accent-light pt-4;
  }

  .marketplace-secondary-button {
    @apply bg-accent-lighter px-4 py-2 text-accent-dark hover:bg-accent-light;
  }

  .marketplace-primary-button {
    @apply bg-accent px-5 py-2 text-overlay-text hover:bg-accent-dark;
  }

  @media (max-width: 640px) {
    .marketplace-input-row,
    .marketplace-modal-actions {
      @apply flex-col;
    }

    .marketplace-add-button,
    .marketplace-primary-button,
    .marketplace-secondary-button {
      @apply w-full;
    }

    .marketplace-source-item {
      @apply items-start;
    }
  }
</style>
