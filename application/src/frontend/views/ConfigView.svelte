<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { fly } from "svelte/transition";
  import { safeFetch } from "../utils";
  import type {
    ConfigurationFile,
  } from "ogi-addon/config";
  import type { OGIAddonConfiguration } from "ogi-addon";
  import { addonUpdates } from "../store";
  import CommunityAddonsList from "./CommunityAddonsList.svelte";
  import AddonPicture from "../components/AddonPicture.svelte";
  import FocusedAddonView from "./FocusedAddonView.svelte";
  import { writable, type Writable } from "svelte/store";


  let addons: ConfigTemplateAndInfo[] = $state([]);
  onMount(() => {
    safeFetch("getAllAddons", {}).then((data) => {
      addons = data;
    });
  });
  interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
    configTemplate: ConfigurationFile;
  }

  let addonsWithUpdates: string[] = $state([]);
  const unsubscribe = addonUpdates.subscribe((update) => {
    addonsWithUpdates = update;
  });

  onDestroy(() => {
    unsubscribe();
    unsubscribe1();
  });

  let view: Writable<"my-addons" | "community-addons"> = writable("my-addons");
  let focusedAddonId: string | null = $state(null);
  
  const unsubscribe1 = view.subscribe(() => {
    safeFetch("getAllAddons", {}).then((data) => {
      addons = data;
    });
  });

  function openAddonSettings(addonId: string) {
    focusedAddonId = addonId;
  }

  function goBackToList() {
    focusedAddonId = null;
  }
</script>
<div class="flex flex-col overflow-y-auto justify-start overflow-x-hidden items-start w-full h-full relative">
  {#if focusedAddonId}
    <div 
      in:fly={{ x: 300, duration: 300 }}
      out:fly={{ x: -300, duration: 300 }}
      class="absolute inset-0 w-full h-full z-10"
    >
      <FocusedAddonView addonId={focusedAddonId} onBack={goBackToList} refreshAddon={() => {
        console.log("Refreshing addon");
        safeFetch("getAllAddons", {}).then((data) => {
          addons = data;
        }).catch((e) => {
          console.error(e);
        });
      }} />
    </div>
  {/if}
  
  {#if !focusedAddonId}
    <div 
      in:fly={{ x: -300, duration: 300 }}
      out:fly={{ x: 300, duration: 300 }}
      class="absolute inset-0 w-full h-full z-10"
    >
      <div class="flex flex-row w-full h-12 gap-4 sticky top-0">
        <button
          data-selected={$view === "my-addons"}
          onclick={() => ($view = "my-addons")}
          class="h-full w-full border-none text-accent-dark font-archivo rounded-lg bg-accent-lighter data-[selected=true]:bg-accent-light shadow-md text-lg hover:bg-accent-light transition-colors"
          >My Addons</button
        >
        <button
          data-selected={$view === "community-addons"}
          onclick={() => ($view = "community-addons")}
          class="h-full w-full border-none text-accent-dark rounded-lg bg-accent-lighter shadow-md data-[selected=true]:bg-accent-light font-archivo text-lg hover:bg-accent-light transition-colors"
          >Community Addons</button
        >
      </div>
      {#if $view === "my-addons"}
          <div class="config">
            <div class="addon-list">
              <section class="selected hidden"></section>
              {#if addons.length !== 0}
                {#each addons as addon}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <section
                    class="addon-card-large hover:cursor-pointer"
                    onkeypress={() => {}}
                    onclick={() => openAddonSettings(addon.id)}
                    id={"cfg-" + addon.id}
                  >
                    <div class="addon-card-content">
                      <div class="addon-icon-container">
                        <AddonPicture addonId={addon.id} class="addon-icon rounded-lg" />
                      </div>
                      <div class="addon-info">
                        <h2 class="addon-title">{addon.name}</h2>
                        <p class="addon-description">{addon.description}</p>
                        {#if addonsWithUpdates.includes(addon.id)}
                          <p class="update-available">Update available</p>
                        {/if}
                      </div>
                      
                    </div>
                    <div class="addon-settings">
                      <button 
                        class="settings-button outline-none border-none text-accent-dark" 
                        aria-label="Open settings"
                        onclick={() => openAddonSettings(addon.id)}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10" fill="currentColor" enable-background="new 0 0 24 24" height="24" viewBox="0 0 24 24" width="24"><rect fill="none" height="24" width="24"/><path d="M19.5,12c0-0.23-0.01-0.45-0.03-0.68l1.86-1.41c0.4-0.3,0.51-0.86,0.26-1.3l-1.87-3.23c-0.25-0.44-0.79-0.62-1.25-0.42 l-2.15,0.91c-0.37-0.26-0.76-0.49-1.17-0.68l-0.29-2.31C14.8,2.38,14.37,2,13.87,2h-3.73C9.63,2,9.2,2.38,9.14,2.88L8.85,5.19 c-0.41,0.19-0.8,0.42-1.17,0.68L5.53,4.96c-0.46-0.2-1-0.02-1.25,0.42L2.41,8.62c-0.25,0.44-0.14,0.99,0.26,1.3l1.86,1.41 C4.51,11.55,4.5,11.77,4.5,12s0.01,0.45,0.03,0.68l-1.86,1.41c-0.4,0.3-0.51,0.86-0.26,1.3l1.87,3.23c0.25,0.44,0.79,0.62,1.25,0.42 l2.15-0.91c0.37,0.26,0.76,0.49,1.17,0.68l0.29,2.31C9.2,21.62,9.63,22,10.13,22h3.73c0.5,0,0.93-0.38,0.99-0.88l0.29-2.31 c0.41-0.19,0.8-0.42,1.17-0.68l2.15,0.91c0.46,0.2,1,0.02,1.25-0.42l1.87-3.23c0.25-0.44,0.14-0.99-0.26-1.3l-1.86-1.41 C19.49,12.45,19.5,12.23,19.5,12z M12.04,15.5c-1.93,0-3.5-1.57-3.5-3.5s1.57-3.5,3.5-3.5s3.5,1.57,3.5,3.5S13.97,15.5,12.04,15.5z"/></svg>
                      </button>
                    </div>
                  </section>
                {/each}
              {/if}
            </div>
          </div>
      {:else if $view === "community-addons"}
        <div class="w-full h-full">
          <CommunityAddonsList />
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .config {
    @apply flex flex-col w-full h-full;
  }
  
  .addon-list {
    @apply flex flex-col w-full gap-4 py-6 px-0 overflow-y-auto;
    max-height: calc(100vh - 200px);
  }
  
  .addon-card-large {
    @apply rounded-lg h-28 duration-200 flex flex-row items-center;
    width: 100%;
  }
  
  .addon-card-content {
    @apply flex items-center justify-between h-full w-full bg-accent-lighter rounded-lg;
  }
  
  .addon-icon-container {
    @apply flex items-center justify-center;
    width: 100px;
    height: 100px;
    flex-shrink: 0;
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
  
  .update-available {
    @apply text-yellow-600 text-sm font-medium mt-1;
  }
  
  .addon-settings {
    @apply flex items-center justify-center mr-4 ml-8;
    width: 70px;
    height: 70px;
    flex-shrink: 0;
  }
  
  .settings-button {
    @apply w-full h-full flex items-center justify-center bg-transparent hover:bg-gray-100 rounded-2xl transition-colors duration-200;
  }
</style>
