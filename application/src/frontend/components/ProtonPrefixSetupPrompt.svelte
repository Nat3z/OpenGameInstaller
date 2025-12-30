<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import type { ProtonPrefixSetup } from '../store';
  import { protonPrefixSetups, createNotification } from '../store';
  import { updateDownloadStatus } from '../utils';
  import { settingUpPrefix } from '../states.svelte';

  let {
    setup,
    downloadId,
  }: {
    setup: ProtonPrefixSetup;
    downloadId: string;
  } = $props();

  let steamKilled = $state(false);
  let steamStarted = $state(false);
  let prefixExists = $state(false);
  let isPolling = $state(false);
  let isInstallingRedist = $state(false);
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  function getDisplayStep(): number {
    // Returns 1-4 for display purposes
    if (prefixExists) return 4;
    if (steamStarted) return 3;
    if (steamKilled) return 2;
    return 1;
  }

  async function killSteam() {
    try {
      const result = await window.electronAPI.app.killSteam();
      if (result.success) {
        steamKilled = true;
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Steam process terminated',
          type: 'success',
        });
      } else {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: result.error || 'Failed to kill Steam',
          type: 'error',
        });
      }
    } catch (error) {
      console.error('Error killing Steam:', error);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Failed to kill Steam',
        type: 'error',
      });
    }
  }

  async function startSteam() {
    try {
      const result = await window.electronAPI.app.startSteam();
      if (result.success) {
        steamStarted = true;
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Steam is starting...',
          type: 'info',
        });
        // Start polling for prefix creation once Steam is started
        startPolling();
      } else {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: result.error || 'Failed to start Steam',
          type: 'error',
        });
      }
    } catch (error) {
      console.error('Error starting Steam:', error);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Failed to start Steam',
        type: 'error',
      });
    }
  }

  async function checkPrefixExists(): Promise<boolean> {
    try {
      const result = await window.electronAPI.app.checkPrefixExists(
        setup.appID
      );
      return result.exists;
    } catch (error) {
      console.error('Error checking prefix:', error);
      return false;
    }
  }

  function startPolling() {
    if (pollInterval) return;
    isPolling = true;

    pollInterval = setInterval(async () => {
      const exists = await checkPrefixExists();
      if (exists) {
        prefixExists = true;
        stopPolling();
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Proton prefix created! Ready to install dependencies.',
          type: 'success',
        });

        // now kill steam and relaunch it
        setTimeout(() => {
          killSteam().then(() => {
            setTimeout(() => {
              window.electronAPI.app.startSteam();
            }, 5000);
          });
        }, 3000);
        settingUpPrefix.appIds.push(setup.appID);
      }
    }, 2000); // Check every 2 seconds
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    isPolling = false;
  }

  async function continueSetup() {
    if (isInstallingRedist) return;

    isInstallingRedist = true;
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: `Installing dependencies for ${setup.gameName}...`,
      type: 'info',
    });

    try {
      const result = await window.electronAPI.app.installRedistributables(
        setup.appID
      );

      if (result === 'success') {
        // Update download status to setup-complete
        updateDownloadStatus(downloadId, { status: 'setup-complete' });

        // Remove from proton prefix setups
        protonPrefixSetups.update((setups) => {
          delete setups[downloadId];
          return setups;
        });

        settingUpPrefix.appIds = settingUpPrefix.appIds.filter(
          (id) => id !== setup.appID
        );

        createNotification({
          id: Math.random().toString(36).substring(7),
          message: `Setup complete for ${setup.gameName}!`,
          type: 'success',
        });
      } else {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: `Failed to install dependencies for ${setup.gameName}`,
          type: 'error',
        });
        isInstallingRedist = false;
      }
    } catch (error) {
      console.error('Error installing redistributables:', error);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: `Failed to install dependencies for ${setup.gameName}`,
        type: 'error',
      });
      isInstallingRedist = false;
    }
  }

  onMount(() => {
    // Check if prefix already exists on mount
    checkPrefixExists().then((exists) => {
      if (exists) {
        prefixExists = true;
        // set the stage to 4
        steamKilled = true;
        steamStarted = true;
        isInstallingRedist = settingUpPrefix.appIds.includes(setup.appID);
      }
    });
  });

  onDestroy(() => {
    stopPolling();
  });
</script>

<div
  class="proton-setup-container bg-white rounded-lg border border-gray-200 shadow-sm p-4 space-y-4"
  in:fade={{ duration: 200 }}
  out:fade={{ duration: 200 }}
>
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-3 h-3 bg-accent rounded-full animate-pulse"></div>
      <div class="flex flex-col">
        <h3 class="text-sm font-archivo font-semibold text-accent-dark">
          Proton Prefix Setup Required
        </h3>
        <p class="text-xs text-gray-600">
          {setup.gameName} • by {setup.addonSource}
        </p>
      </div>
    </div>

    <div class="flex items-center gap-2 text-sm text-accent-dark">
      <span class="text-xs bg-accent-lighter px-2 py-1 rounded-full">
        Step {getDisplayStep()} of 4
      </span>
    </div>
  </div>

  <!-- Progress Bar -->
  <div class="w-full bg-accent-lighter rounded-full h-2">
    <div
      class="bg-accent h-2 rounded-full transition-all duration-500"
      style="width: {(getDisplayStep() / 4) * 100}%"
    ></div>
  </div>

  <!-- Info Box -->
  <div
    class="info-box bg-accent-lighter/50 rounded-lg p-3 border border-accent-light"
  >
    <p class="text-xs text-accent-dark leading-relaxed">
      This game requires additional dependencies. To install them, we need to
      create a Proton prefix by launching the game through Steam once. Follow
      the steps below:
    </p>
  </div>

  <!-- Action Buttons -->
  <div class="steps-container space-y-3">
    <!-- Step 1: Kill Steam -->
    <div class="step-item flex items-center gap-3">
      <div
        class="step-number w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold {steamKilled
          ? 'bg-accent text-white'
          : 'bg-gray-200 text-gray-600'}"
      >
        {#if steamKilled}
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clip-rule="evenodd"
            ></path>
          </svg>
        {:else}
          1
        {/if}
      </div>
      <button
        class="step-button flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all {steamKilled
          ? 'bg-accent/20 text-accent-dark cursor-default'
          : 'bg-accent text-white hover:bg-accent-dark'}"
        onclick={killSteam}
        disabled={steamKilled}
      >
        {steamKilled ? 'Steam Killed ✓' : 'Kill Steam'}
      </button>
    </div>

    <!-- Step 2: Start Steam -->
    <div class="step-item flex items-center gap-3">
      <div
        class="step-number w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold {steamStarted
          ? 'bg-accent text-white'
          : steamKilled
            ? 'bg-gray-300 text-gray-700'
            : 'bg-gray-200 text-gray-400'}"
      >
        {#if steamStarted}
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clip-rule="evenodd"
            ></path>
          </svg>
        {:else}
          2
        {/if}
      </div>
      <button
        class="step-button flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all {steamStarted
          ? 'bg-accent/20 text-accent-dark cursor-default'
          : steamKilled
            ? 'bg-accent text-white hover:bg-accent-dark'
            : 'bg-gray-200 text-gray-400 cursor-not-allowed'}"
        onclick={startSteam}
        disabled={!steamKilled || steamStarted}
      >
        {steamStarted ? 'Steam Started ✓' : 'Start Steam'}
      </button>
    </div>

    <!-- Step 3: Launch Game (Instructions) -->
    <div class="step-item flex items-center gap-3">
      <div
        class="step-number w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold {prefixExists
          ? 'bg-accent text-white'
          : steamStarted
            ? 'bg-gray-300 text-gray-700'
            : 'bg-gray-200 text-gray-400'}"
      >
        {#if prefixExists}
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clip-rule="evenodd"
            ></path>
          </svg>
        {:else}
          3
        {/if}
      </div>
      <div
        class="step-instruction flex-1 py-2 px-4 rounded-lg text-sm {prefixExists
          ? 'bg-accent/20 text-accent-dark'
          : steamStarted
            ? 'bg-accent-lighter border border-accent-light text-accent-dark'
            : 'bg-gray-100 text-gray-400'}"
      >
        {#if prefixExists}
          <span class="font-medium text-center w-full">Game Launched ✓</span>
        {:else if steamStarted}
          <span class="font-medium"
            >Launch the game in Steam, then close it</span
          >
          <p class="text-xs mt-1 opacity-75">
            Find "{setup.gameName}" in your Steam library and run it once to
            create the Proton prefix.
          </p>
        {:else}
          <span class="font-medium text-gray-500">Launch the game in Steam</span
          >
        {/if}
      </div>
    </div>

    <!-- Step 4: Continue -->
    <div class="step-item flex items-center gap-3">
      <div
        class="step-number w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold {prefixExists
          ? 'bg-accent text-white'
          : 'bg-gray-200 text-gray-400'}"
      >
        {#if isInstallingRedist}
          <div
            class="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"
          ></div>
        {:else}
          4
        {/if}
      </div>
      <button
        class="step-button flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all {prefixExists &&
        !isInstallingRedist
          ? 'bg-accent text-white hover:bg-accent-dark'
          : 'bg-gray-200 text-gray-400 cursor-not-allowed'}"
        onclick={continueSetup}
        disabled={!prefixExists || isInstallingRedist}
      >
        {#if isInstallingRedist}
          Installing Dependencies...
        {:else if prefixExists}
          Continue & Install Dependencies
        {:else}
          Waiting for Proton Prefix...
        {/if}
      </button>
    </div>
  </div>

  <!-- Polling Status -->
  {#if isPolling && !prefixExists}
    <div
      class="polling-status flex items-center gap-2 text-xs text-accent-dark bg-accent-lighter/30 rounded-lg p-2"
    >
      <div class="w-2 h-2 bg-accent rounded-full animate-pulse"></div>
      <span>Waiting for Proton prefix to be created...</span>
    </div>
  {/if}

  <!-- Dependencies Info -->
  {#if setup.redistributables && setup.redistributables.length > 0}
    <div class="dependencies-info border-t border-gray-200 pt-3 mt-2">
      <p class="text-xs text-gray-500 mb-2">Dependencies to install:</p>
      <div class="flex flex-wrap gap-1">
        {#each setup.redistributables as redist}
          <span class="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
            {redist.name}
          </span>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .proton-setup-container {
    border: 1px solid theme('colors.accent-light');
    background: linear-gradient(
      135deg,
      theme('colors.background-color') 0%,
      theme('colors.accent-lighter') 100%
    );
  }

  .step-button:disabled {
    cursor: not-allowed;
  }

  .step-button:not(:disabled):hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(66, 138, 145, 0.3);
  }
</style>
