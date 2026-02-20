<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { selectedView, gameFocused, launchGameTrigger } from '../store';
  import { safeFetch } from '../utils';

  interface Props {
    gameId: number;
    onComplete: () => void;
    onError: (error: string) => void;
  }

  let { gameId, onComplete, onError }: Props = $props();

  let gameName = $state('Please wait');
  let status = $state<'loading' | 'running' | 'success' | 'error'>('loading');
  let errorMessage = $state('');
  let hookType: 'pre' | 'post' | null = $state(null);
  let isHookOnly = $state(false);

  onMount(async () => {
    // Parse query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const hookTypeParam = urlParams.get('hookType');
    const noLaunchParam = urlParams.get('noLaunch');

    isHookOnly =
      noLaunchParam === 'true' &&
      (hookTypeParam === 'pre' || hookTypeParam === 'post');
    hookType = hookTypeParam as 'pre' | 'post' | null;

    // wait 200 ms for the events to register
    await new Promise((r) => setTimeout(r, 200));

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
      status = 'running';

      if (isHookOnly && hookType) {
        // Hook-only mode: run addon event without launching game
        console.log(
          `[GameLaunchOverlay] Running ${hookType}-launch hooks for ${gameName}`
        );

        try {
          await safeFetch('launchApp', {
            libraryInfo: libraryInfo,
            launchType: hookType,
          });

          status = 'success';
          console.log(`[GameLaunchOverlay] ${hookType}-launch hooks completed`);

          // Wait a moment then close the app
          setTimeout(() => {
            onComplete();
            // Close the app entirely
            window.electronAPI.app.quit();
          }, 2000);
        } catch (error) {
          console.error(
            `[GameLaunchOverlay] ${hookType}-launch hooks failed:`,
            error
          );
          status = 'error';
          errorMessage =
            error instanceof Error ? error.message : 'Hook execution failed';
          onError(errorMessage);

          // Still close the app after showing error for a bit
          setTimeout(() => {
            window.electronAPI.app.quit();
          }, 5000);
        }
      } else if (libraryInfo.umu) {
        // Open the play page in the background and trigger the play button
        // so that the full PlayPage launch flow (addon pre-launch, etc.) runs
        selectedView.set('library');
        gameFocused.set(gameId);

        // Wait for LibraryView to load and open PlayPage, then trigger play
        await new Promise((r) => setTimeout(r, 800));
        launchGameTrigger.set(gameId);

        // Keep this overlay mounted for Steam shortcut launches.
        // The window will be hidden on game:launch and shown again on game:exit.
        status = 'running';
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
>
  <div
    class="flex flex-col items-center gap-6 p-8"
  >
    {#if status === 'loading' || status === 'running'}
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
        {:else if status === 'running'}
          {#if isHookOnly}
            Running {hookType}-launch hooks...
          {:else}
            Launching game...
          {/if}
        {:else if status === 'success'}
          {#if isHookOnly}
            {hookType === 'pre' ? 'Pre-launch' : 'Post-launch'} hooks complete!
          {:else}
            Game launched!
          {/if}
        {:else if status === 'error'}
          {#if isHookOnly}
            {hookType === 'pre' ? 'Pre-launch' : 'Post-launch'} hooks failed
          {:else}
            Launch failed
          {/if}
        {/if}
      </h2>

      <p class="text-lg opacity-80">{gameName}</p>

      {#if status === 'error'}
        <p class="text-sm text-red-400 mt-4 max-w-md opacity-70">
          {errorMessage}
        </p>
      {/if}

      {#if isHookOnly && status === 'success'}
        <p class="text-sm text-gray-400 mt-4">Closing application...</p>
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
  {#if status === 'running'}
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
