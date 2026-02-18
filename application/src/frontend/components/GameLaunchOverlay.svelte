<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { gamesLaunched } from '../store';

  interface Props {
    gameId: number;
    onComplete: () => void;
    onError: (error: string) => void;
  }

  let { gameId, onComplete, onError }: Props = $props();

  let gameName = $state('Please wait');
  let status = $state<'loading' | 'launching' | 'success' | 'error'>('loading');
  let errorMessage = $state('');
  let progress = $state(0);

  onMount(async () => {
    try {
      // Load library info
      const libraryInfo = await window.electronAPI.app.getLibraryInfo(gameId);

      if (!libraryInfo) {
        status = 'error';
        errorMessage = 'Game not found in library';
        onError('Game not found');
        return;
      }

      gameName = libraryInfo.name;
      status = 'launching';

      // Check if this is a UMU game
      if (libraryInfo.umu) {
        // Launch the game
        await window.electronAPI.app.launchGame('' + gameId);

        // Update store
        gamesLaunched.update((games) => {
          games[gameId] = 'launched';
          return games;
        });

        status = 'success';

        // Wait a moment then complete
        setTimeout(() => {
          onComplete();
        }, 2000);
      } else {
        status = 'error';
        errorMessage =
          'Game is not configured for Steam shortcut launching (UMU mode required)';
        onError(errorMessage);
      }
    } catch (error) {
      console.error('[GameLaunchOverlay] Error launching game:', error);
      status = 'error';
      errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      onError(errorMessage);
    }
  });

  onDestroy(() => {
    // Clean up if needed
  });
</script>

<div
  class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#1a1a1a] text-white"
  in:fade={{ duration: 300 }}
  out:fade={{ duration: 300 }}
>
  <div
    class="flex flex-col items-center gap-6 p-8"
    in:fly={{ y: 20, duration: 500, easing: quintOut }}
  >
    {#if status === 'loading' || status === 'launching'}
      <!-- Spinner -->
      <div class="relative">
        <div
          class="w-16 h-16 border-4 border-[#333] border-t-[#4CAF50] rounded-full animate-spin"
        ></div>
      </div>
    {:else if status === 'success'}
      <!-- Success checkmark -->
      <div class="w-16 h-16 flex items-center justify-center">
        <svg
          class="w-12 h-12 text-[#4CAF50]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="3"
            d="M5 13l4 4L19 7"
          ></path>
        </svg>
      </div>
    {:else if status === 'error'}
      <!-- Error icon -->
      <div class="w-16 h-16 flex items-center justify-center">
        <svg
          class="w-12 h-12 text-red-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="3"
            d="M6 18L18 6M6 6l12 12"
          ></path>
        </svg>
      </div>
    {/if}

    <div class="text-center">
      <h2 class="text-2xl font-semibold mb-2">
        {#if status === 'loading'}
          Loading game info...
        {:else if status === 'launching'}
          Launching game...
        {:else if status === 'success'}
          Game launched!
        {:else if status === 'error'}
          Launch failed
        {/if}
      </h2>

      <p class="text-lg opacity-80">{gameName}</p>

      {#if status === 'error'}
        <p class="text-sm text-red-400 mt-4 max-w-md opacity-70">
          {errorMessage}
        </p>
      {/if}
    </div>

    {#if status === 'error'}
      <button
        class="mt-6 px-6 py-3 bg-[#333] hover:bg-[#444] rounded-lg transition-colors border-none text-white cursor-pointer"
        onclick={onComplete}
      >
        Close
      </button>
    {/if}
  </div>

  <!-- Progress bar for visual feedback -->
  {#if status === 'launching'}
    <div class="absolute bottom-0 left-0 w-full h-1 bg-[#333]">
      <div class="h-full bg-[#4CAF50] animate-pulse" style="width: 100%"></div>
    </div>
  {/if}
</div>

<style>
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .animate-spin {
    animation: spin 1s linear infinite;
  }
</style>
