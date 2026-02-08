<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { safeFetch } from '../utils';
  import type { ConfigurationFile } from 'ogi-addon/config';
  import type { OGIAddonConfiguration } from 'ogi-addon';
  import { addonUpdates, createNotification } from '../store';
  import CommunityAddonsList from './CommunityAddonsList.svelte';
  import AddonPicture from '../components/AddonPicture.svelte';
  import FocusedAddonView from './FocusedAddonView.svelte';
  import { writable } from 'svelte/store';
  import Modal from '../components/modal/Modal.svelte';
  import TextModal from '../components/modal/TextModal.svelte';
  import TitleModal from '../components/modal/TitleModal.svelte';
  import CloseModal from '../components/modal/CloseModal.svelte';
  import ButtonModal from '../components/modal/ButtonModal.svelte';
  import HeaderModal from '../components/modal/HeaderModal.svelte';
  import SectionModal from '../components/modal/SectionModal.svelte';
  import InputModal from '../components/modal/InputModal.svelte';

  let addons: ConfigTemplateAndInfo[] = $state([]);
  let communityAddonsInfo: boolean = $state(false);
  let showAddonAddModal: boolean = $state(false);
  let addonUrl: string = $state('');
  let pollingInterval: any = null;
  let view = writable<'my-addons' | 'community-addons'>('my-addons');

  onMount(() => {
    // Initial fetch
    safeFetch('getAllAddons', {}).then((data) => {
      addons = data;
    });
    // Start polling every 3 seconds
    pollingInterval = setInterval(() => {
      safeFetch('getAllAddons', {}).then((data) => {
        addons = data;
      });
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
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Addons updated successfully',
        type: 'success',
      });
      addonUpdates.set([]);
      // restart the addon server
      await window.electronAPI.restartAddonServer();
      // No need to manually refresh addons, polling will handle it
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
    console.log('Adding addon', addonUrl);
    const generalConfig = window.electronAPI.fs.read(
      './config/option/general.json'
    );
    const generalConfigJson = JSON.parse(generalConfig);
    generalConfigJson.addons.push(addonUrl);
    window.electronAPI.fs.write(
      './config/option/general.json',
      JSON.stringify(generalConfigJson)
    );
    showAddonAddModal = false;

    createNotification({
      id: Math.random().toString(36).substring(7),
      message: 'Installing addon...',
      type: 'info',
    });
    await window.electronAPI.installAddons([addonUrl]);
    addonUrl = '';
    await window.electronAPI.restartAddonServer();
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
        {#if $view === 'my-addons'}
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
                class="absolute -bottom-1 -right-1 bg-accent rounded-full w-4 h-4 animate-pulse"
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
          <div class="flex justify-center items-center">
            <button
              class="bg-accent-lighter h-full text-accent-dark px-6 py-3 rounded-lg font-archivo font-semibold hover:bg-accent-light transition-colors border-none shadow-md flex items-center gap-2"
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
                          class="absolute -bottom-1 -right-1 bg-accent rounded-full w-4 h-4 animate-pulse"
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
    @apply text-2xl font-semibold text-text mb-2;
  }

  .addon-description {
    @apply text-lg text-text-muted leading-relaxed;
  }

  .update-badge {
    @apply inline-flex items-center gap-2 px-3 py-1.5 bg-linear-to-r from-accent to-accent-dark text-accent-text-color text-sm font-semibold rounded-full mt-2 shadow-sm hover:shadow-md transition-all duration-200 transform hover:scale-105;
    max-width: fit-content;
  }

  .update-icon {
    @apply w-4 h-4;
    animation: pulse 2s infinite;
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
    @apply w-full h-full flex items-center justify-center bg-transparent hover:bg-surface rounded-2xl transition-colors duration-200;
  }
</style>
