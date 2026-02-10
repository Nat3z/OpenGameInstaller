<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import type { SetupLog } from '../store';

  let {
    setupLog,
    downloadName,
    addonSource,
  }: {
    setupLog: SetupLog;
    downloadName: string;
    addonSource: string;
  } = $props();

  let logContainer: HTMLDivElement | null = $state(null);
  let previousLogLength = $state(0);

  // Auto-scroll when new logs are added
  $effect(() => {
    if (logContainer && setupLog.logs.length > previousLogLength) {
      logContainer.scrollTo({
        top: logContainer.scrollHeight,
        behavior: 'smooth',
      });
      previousLogLength = setupLog.logs.length;
    }
  });

  // Initialize previous log length
  onMount(() => {
    previousLogLength = setupLog.logs.length;
  });

  function formatProgress(progress: number): string {
    return Math.floor(progress).toString();
  }
</script>

<div
  class="setup-prompt-container bg-surface rounded-lg border border-border shadow-sm p-4 space-y-3"
  in:fade={{ duration: 200 }}
  out:fade={{ duration: 200 }}
>
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-2 h-2 bg-accent rounded-full animate-pulse"></div>
      <div class="flex flex-col">
        <h3 class="text-sm font-archivo font-semibold text-accent-dark">
          Setting up {downloadName}
        </h3>
        <p class="text-xs text-text-secondary">
          by {addonSource}
        </p>
      </div>
    </div>

    <div class="flex items-center gap-2 text-sm text-accent-dark">
      <div class="w-2 h-2 bg-accent rounded-full"></div>
      {formatProgress(setupLog.progress)}%
    </div>
  </div>

  <!-- Progress Bar -->
  {#if setupLog.progress > 0}
    <div class="w-full bg-accent-lighter rounded-full h-2">
      <div
        class="bg-accent h-2 rounded-full transition-all duration-300"
        style="width: {setupLog.progress}%"
      ></div>
    </div>
  {/if}

  <!-- Terminal Log Display -->
  <div class="setup-terminal">
    <div class="terminal-header">
      <div class="flex items-center gap-2">
        <span class="text-xs text-text-muted font-mono">Setup Console</span>
      </div>
    </div>

    <div bind:this={logContainer} class="terminal-content">
      {#if setupLog.logs.length === 0}
        <div class="text-green-400 font-mono text-sm opacity-75">
          Initializing setup process...
        </div>
      {:else}
        {#each setupLog.logs as log, index}
          <div
            class="terminal-line"
            in:fade={{ duration: 150, delay: index * 20 }}
          >
            <span class="text-green-400 font-mono text-sm leading-relaxed">
              {log}
            </span>
          </div>
        {/each}
        <div class="terminal-cursor">
          <span class="text-green-400 font-mono text-sm animate-pulse">▋</span>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  @reference "../app.css";
  .setup-prompt-container {
    border: 1px solid var(--color-accent-light);
    background: linear-gradient(
      135deg,
      var(--color-background-color) 0%,
      var(--color-accent-lighter) 100%
    );
  }

  .setup-terminal {
    @apply bg-gray-900 rounded-lg overflow-hidden border border-border-strong;
  }

  .terminal-header {
    @apply bg-gray-800 px-4 py-2 border-b border-border-strong;
  }

  .terminal-content {
    @apply p-4 max-h-48 overflow-y-auto;
    scrollbar-width: thin;
    scrollbar-color: var(--color-accent) #1f2937;
  }

  .terminal-content::-webkit-scrollbar {
    width: 6px;
  }

  .terminal-content::-webkit-scrollbar-track {
    background: #1f2937;
  }

  .terminal-content::-webkit-scrollbar-thumb {
    background: var(--color-accent);
    border-radius: 3px;
  }

  .terminal-content::-webkit-scrollbar-thumb:hover {
    background: var(--color-accent-dark);
  }

  .terminal-line {
    @apply mb-1;
    word-wrap: break-word;
    white-space: pre-wrap;
  }

  .terminal-cursor {
    @apply mt-2;
  }
</style>
