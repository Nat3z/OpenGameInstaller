<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import {
    getLastSync,
    syncDown,
    subscribeCloudSaveStatus,
    type CloudSaveStatusPayload,
  } from '../lib/cloudsave/client';
  import type { LibraryInfo } from 'ogi-addon';

  interface Props {
    libraryInfo: LibraryInfo;
  }
  let { libraryInfo }: Props = $props();

  let lastSync = $state<{ up?: number; down?: number } | null>(null);
  let status = $state<'idle' | 'syncing-down' | 'syncing-up' | 'up-complete' | 'error'>('idle');
  let errorMessage = $state<string | null>(null);
  let enabled = $state(false);
  let unsub = $state<(() => void) | null>(null);

  onMount(async () => {
    enabled = await window.electronAPI.cloudsave.isEnabledForApp(
      libraryInfo.appID
    );
    if (enabled) {
      lastSync = await getLastSync(libraryInfo.appID);
      unsub = subscribeCloudSaveStatus((payload: CloudSaveStatusPayload) => {
        if (payload.appID !== libraryInfo.appID) return;
        if (payload.status === 'syncing-down') status = 'syncing-down';
        else if (payload.status === 'syncing-up') status = 'syncing-up';
        else if (payload.status === 'up-complete') {
          status = 'up-complete';
          lastSync = { ...lastSync, up: Date.now() };
          setTimeout(() => (status = 'idle'), 3000);
        } else if (payload.status === 'down-complete') {
          status = 'idle';
          lastSync = { ...lastSync, down: Date.now() };
        } else if (payload.status === 'error') {
          status = 'error';
          errorMessage = payload.message;
          setTimeout(() => {
            status = 'idle';
            errorMessage = null;
          }, 5000);
        }
      });
    }
  });

  onDestroy(() => {
    unsub?.();
  });

  async function downloadBeforePlay() {
    status = 'syncing-down';
    const r = await syncDown(libraryInfo.appID);
    if (r.success) {
      lastSync = { ...lastSync, down: Date.now() };
      status = 'idle';
    } else {
      status = 'error';
      errorMessage = r.error ?? 'Download failed';
      setTimeout(() => {
        status = 'idle';
        errorMessage = null;
      }, 5000);
    }
  }

  function formatTime(ts: number | undefined): string {
    if (ts == null) return 'Never';
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return 'Just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return d.toLocaleDateString();
  }
</script>

{#if enabled}
  <div
    class="bg-accent-lighter rounded-lg p-5 mx-0 mt-6 flex flex-col gap-3"
    in:fly={{ y: -20, duration: 300 }}
  >
    <div class="flex items-start gap-3">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        class="w-6 h-6 fill-accent-dark shrink-0 mt-0.5"
      >
        <path
          d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"
        />
      </svg>
      <div class="flex-1 min-w-0">
        <h3 class="text-base font-archivo font-bold text-accent-dark">
          Cloud Save
        </h3>
        {#if status === 'syncing-down'}
          <p class="text-accent-dark text-sm">Downloading cloud save…</p>
        {:else if status === 'syncing-up'}
          <p class="text-accent-dark text-sm">Uploading save to cloud…</p>
        {:else if status === 'up-complete'}
          <p class="text-accent-dark text-sm text-green-600">
            Saved to cloud
          </p>
        {:else if status === 'error'}
          <p class="text-accent-dark text-sm text-red-600">
            {errorMessage ?? 'Error'}
          </p>
        {:else}
          <p class="text-accent-dark text-sm">
            Last upload: {formatTime(lastSync?.up)} · Last download:{' '}
            {formatTime(lastSync?.down)}
          </p>
        {/if}
      </div>
    </div>
    {#if status === 'idle' || status === 'syncing-down'}
      <div class="flex gap-3">
        <button
          type="button"
          class="px-4 py-2 bg-accent-light hover:bg-accent-light/80 text-accent-dark font-archivo font-semibold rounded-lg border-none flex items-center justify-center gap-2 transition-colors duration-200 flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={status === 'syncing-down'}
          onclick={() => downloadBeforePlay()}
        >
          {#if status === 'syncing-down'}
            Downloading…
          {:else}
            Download cloud save before play
          {/if}
        </button>
      </div>
    {/if}
  </div>
{/if}
