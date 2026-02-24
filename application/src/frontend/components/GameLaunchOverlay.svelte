<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    selectedView,
    gameFocused,
    launchGameTrigger,
    launchOverlayPlayPageReady,
  } from '../store';
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
  let wrapperCommand: string | null = $state(null);
  let isWrapperLaunch = $state(false);
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  let isMounted = false;

  onMount(async () => {
    isMounted = true;
    // Parse query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const hookTypeParam = urlParams.get('hookType');
    const noLaunchParam = urlParams.get('noLaunch');
    wrapperCommand = urlParams.get('wrapperCommand');
    isWrapperLaunch = !!wrapperCommand;

    hookType =
      hookTypeParam === 'pre'
        ? 'pre'
        : hookTypeParam === 'post'
          ? 'post'
          : null;
    isHookOnly =
      noLaunchParam === 'true' && hookType !== null;

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

          const t = setTimeout(() => {
            if (isMounted) {
              onComplete();
              window.electronAPI.app.quit();
            }
          }, 2000);
          timeouts.push(t);
        } catch (error) {
          console.error(
            `[GameLaunchOverlay] ${hookType}-launch hooks failed:`,
            error
          );
          status = 'error';
          errorMessage =
            error instanceof Error ? error.message : 'Hook execution failed';
          onError(errorMessage);

          const t = setTimeout(() => {
            if (isMounted) window.electronAPI.app.quit();
          }, 5000);
          timeouts.push(t);
        }
      } else if (isWrapperLaunch && wrapperCommand) {
        // Wrapper mode: run pre-launch hooks, execute wrapper command exactly, then run post-launch hooks
        console.log(
          `[GameLaunchOverlay] Running wrapped launch for ${gameName}: ${wrapperCommand}`
        );

        try {
          await safeFetch('launchApp', {
            libraryInfo: libraryInfo,
            launchType: 'pre',
          });
        } catch (error) {
          console.error('[GameLaunchOverlay] Pre-launch hooks failed:', error);
          status = 'error';
          errorMessage =
            error instanceof Error ? error.message : 'Pre-launch failed';
          onError(errorMessage);
          const t = setTimeout(() => {
            if (isMounted) window.electronAPI.app.quit();
          }, 5000);
          timeouts.push(t);
          return;
        }

        let wrapperError: string | null = null;
        await window.electronAPI.app.hideWindow();
        const wrapperResult =
          await window.electronAPI.app.executeWrapperCommand(
            gameId,
            wrapperCommand
          );
        if (!wrapperResult.success) {
          wrapperError = wrapperResult.error || 'Wrapped command failed';
        }
        await window.electronAPI.app.showWindow();

        let postLaunchError: string | null = null;
        try {
          await safeFetch('launchApp', {
            libraryInfo: libraryInfo,
            launchType: 'post',
          });
        } catch (error) {
          console.error('[GameLaunchOverlay] Post-launch hooks failed:', error);
          postLaunchError =
            error instanceof Error ? error.message : 'Post-launch failed';
        }

        if (wrapperError || postLaunchError) {
          status = 'error';
          errorMessage =
            wrapperError && postLaunchError
              ? `${wrapperError}\n${postLaunchError}`
              : (wrapperError ?? postLaunchError ?? 'Wrapped launch failed');
          onError(errorMessage);
          const t2 = setTimeout(() => {
            if (isMounted) window.electronAPI.app.quit();
          }, 5000);
          timeouts.push(t2);
          return;
        }

        status = 'success';
        const t3 = setTimeout(() => {
          if (isMounted) {
            onComplete();
            window.electronAPI.app.quit();
          }
        }, 2000);
        timeouts.push(t3);
      } else if (libraryInfo.umu) {
        // Open the play page in the background and trigger the play button
        // so that the full PlayPage launch flow (addon pre-launch, etc.) runs
        launchOverlayPlayPageReady.set(undefined);
        selectedView.set('library');
        gameFocused.set(gameId);

        const READINESS_TIMEOUT_MS = 5000;
        const ready = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => {
            unsub();
            resolve(false);
          }, READINESS_TIMEOUT_MS);
          const unsub = launchOverlayPlayPageReady.subscribe((readyGameId) => {
            if (readyGameId === gameId) {
              clearTimeout(timeout);
              unsub();
              resolve(true);
            }
          });
        });
        if (!ready) {
          status = 'error';
          errorMessage =
            'Library view did not load in time. Please try launching again.';
          onError(errorMessage);
          return;
        }
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
    isMounted = false;
    for (const id of timeouts) clearTimeout(id);
    timeouts.length = 0;
  });
</script>

<div
  class="fixed inset-0 z-10 flex flex-col items-center justify-center bg-[#1a1a1a] text-white"
>
  <div class="flex flex-col items-center gap-6 p-8">
    {#if status === 'loading' || status === 'running'}
      <!-- Spinner -->
      <div class="relative">
        <div
          class="w-16 h-16 border-4 border-[#333] border-t-[#4CAF50] rounded-full custom-animate-spin"
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
          {:else if isWrapperLaunch}
            Running wrapped launch...
          {:else}
            Launching game...
          {/if}
        {:else if status === 'success'}
          {#if isHookOnly}
            {hookType === 'pre' ? 'Pre-launch' : 'Post-launch'} hooks complete!
          {:else if isWrapperLaunch}
            Wrapped launch complete!
          {:else}
            Game launched!
          {/if}
        {:else if status === 'error'}
          {#if isHookOnly}
            {hookType === 'pre' ? 'Pre-launch' : 'Post-launch'} hooks failed
          {:else if isWrapperLaunch}
            Wrapped launch failed
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

      {#if isHookOnly || isWrapperLaunch}
        <p class="text-sm text-gray-400 mt-4">Closing application...</p>
      {/if}
    </div>
  </div>

  <!-- Progress bar for visual feedback -->
  {#if status === 'running'}
    <div class="absolute bottom-0 left-0 w-full h-1 bg-[#333]">
      <div class="h-full bg-[#4CAF50] animate-pulse" style="width: 100%"></div>
    </div>
  {/if}
</div>

<style>
  @keyframes custom-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .custom-animate-spin {
    animation: custom-spin 1s linear infinite;
  }
</style>
