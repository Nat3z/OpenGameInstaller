<script lang="ts">
  import { fade } from 'svelte/transition';
  import type { RedistributableInstall } from '../store';

  let {
    setup,
  }: {
    setup: RedistributableInstall;
  } = $props();

  // Get current redistributable being installed
  const currentRedistributable = $derived(() => {
    return setup.redistributables.find((r) => r.status === 'installing');
  });

  // Get next pending redistributable
  const nextRedistributable = $derived(() => {
    const pending = setup.redistributables.filter(
      (r) => r.status === 'pending'
    );
    return pending[0];
  });

  // Calculate progress percentage
  const progressPercent = $derived(() => {
    return Math.round(setup.overallProgress);
  });
</script>

<div
  class="redistributables-progress bg-surface rounded-lg border border-border shadow-sm p-4 space-y-4 w-full"
  in:fade={{ duration: 200 }}
  out:fade={{ duration: 200 }}
>
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-3 h-3 bg-accent rounded-full animate-pulse"></div>
      <div class="flex flex-col">
        <h3 class="text-sm font-archivo font-semibold text-accent-dark">
          Installing Dependencies...
        </h3>
        <p class="text-xs text-text-secondary">
          {setup.gameName}
        </p>
      </div>
    </div>

    <div class="flex items-center gap-2 text-sm text-accent-dark">
      <span class="text-xs bg-accent-lighter px-2 py-1 rounded-full">
        {progressPercent()}%
      </span>
    </div>
  </div>

  <!-- Progress Bar -->
  <div class="w-full bg-accent-lighter rounded-full h-2">
    <div
      class="bg-accent h-2 rounded-full transition-all duration-500"
      style="width: {setup.overallProgress}%"
    ></div>
  </div>

  <!-- Current Status -->
  <div class="space-y-2">
    {#if currentRedistributable()}
      <div class="flex items-center gap-2 text-sm text-accent-dark">
        <div
          class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"
        ></div>
        <span
          >Installing: <strong>{currentRedistributable()?.name}</strong></span
        >
      </div>
    {:else if setup.isComplete}
      <div class="flex items-center gap-2 text-sm text-green-600">
        <svg
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M5 13l4 4L19 7"
          ></path>
        </svg>
        <span>Installation complete!</span>
      </div>
    {/if}

    {#if nextRedistributable() && !setup.isComplete}
      <div class="flex items-center gap-2 text-sm text-text-secondary">
        <div class="w-4 h-4 rounded-full border border-text-muted"></div>
        <span>Next: {nextRedistributable()?.name}</span>
      </div>
    {/if}
  </div>

  <!-- Dependencies List (collapsed view) -->
  {#if setup.redistributables.length > 0}
    <div class="dependencies-list border-t border-border pt-3">
      <p class="text-xs text-text-muted mb-2">Dependencies:</p>
      <div class="flex flex-wrap gap-1">
        {#each setup.redistributables as redist}
          <span
            class="text-xs px-2 py-1 rounded transition-colors duration-300"
            class:bg-green-100={redist.status === 'completed'}
            class:text-green-700={redist.status === 'completed'}
            class:bg-red-100={redist.status === 'failed'}
            class:text-red-700={redist.status === 'failed'}
            class:bg-accent-lighter={redist.status === 'pending' ||
              redist.status === 'installing'}
            class:text-accent-dark={redist.status === 'pending' ||
              redist.status === 'installing'}
          >
            {#if redist.status === 'completed'}
              ✓
            {:else if redist.status === 'failed'}
              ✗
            {:else if redist.status === 'installing'}
              ⟳
            {:else}
              ○
            {/if}
            {redist.name}
          </span>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  @reference "../app.css";
  .redistributables-progress {
    border: 1px solid var(--color-accent-light);
    background: linear-gradient(
      135deg,
      var(--color-background-color) 0%,
      var(--color-accent-lighter) 100%
    );
  }

  .animate-spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .dependencies-list span {
    transition: all 0.3s ease;
  }
</style>
