<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import type { LibraryInfo } from 'ogi-addon';
  import {
    getCloudSaveConfig,
    setCloudSaveConfig,
    syncUp,
    syncDown,
    type CloudSaveConfig,
  } from '../lib/cloudsave/client';
  import { createNotification } from '../store';

  let config = $state<CloudSaveConfig>({ enabled: false, perGame: {} });
  let apps = $state<LibraryInfo[]>([]);
  let syncingAppID = $state<number | null>(null);
  let expandedAppID = $state<number | null>(null);

  onMount(async () => {
    config = await getCloudSaveConfig();
    apps = await window.electronAPI.app.getAllApps();
  });

  function setGlobalEnabled(enabled: boolean) {
    config = { ...config, enabled };
    setCloudSaveConfig(config);
  }

  function setGameEnabled(appID: number, enabled: boolean) {
    const key = String(appID);
    const perGame = { ...config.perGame };
    if (enabled) {
      perGame[key] = { enabled: true, paths: perGame[key]?.paths ?? [] };
    } else {
      delete perGame[key];
    }
    config = { ...config, perGame };
    setCloudSaveConfig(config);
  }

  function addPath(appID: number, name: string, path: string) {
    const key = String(appID);
    const perGame = { ...config.perGame };
    const entry = perGame[key] ?? { enabled: true, paths: [] };
    entry.paths = [...entry.paths, { name: name || 'Save', path }];
    perGame[key] = entry;
    config = { ...config, perGame };
    setCloudSaveConfig(config);
  }

  function removePath(appID: number, index: number) {
    const key = String(appID);
    const perGame = { ...config.perGame };
    const entry = perGame[key];
    if (!entry) return;
    entry.paths = entry.paths.filter((_, i) => i !== index);
    if (entry.paths.length === 0) delete perGame[key];
    else perGame[key] = entry;
    config = { ...config, perGame };
    setCloudSaveConfig(config);
  }

  async function pickFolder(appID: number) {
    const paths = await window.electronAPI.fs.dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (paths && paths.length > 0) {
      addPath(appID, 'Save folder', paths[0]);
    }
  }

  async function doSyncUp(appID: number) {
    syncingAppID = appID;
    try {
      const r = await syncUp(appID);
      if (r.success) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Cloud save uploaded',
          type: 'success',
        });
      } else {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: r.error ?? 'Upload failed',
          type: 'error',
        });
      }
    } finally {
      syncingAppID = null;
    }
  }

  async function doSyncDown(appID: number) {
    syncingAppID = appID;
    try {
      const r = await syncDown(appID);
      if (r.success) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Cloud save downloaded',
          type: 'success',
        });
      } else {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: r.error ?? 'Download failed',
          type: 'error',
        });
      }
    } finally {
      syncingAppID = null;
    }
  }

  function toggleExpand(appID: number) {
    expandedAppID = expandedAppID === appID ? null : appID;
  }
</script>

<div class="cloudsave-settings flex flex-col w-full h-full overflow-y-auto gap-6 py-6">
  <div
    class="bg-accent-lighter rounded-lg p-5 flex flex-row items-center justify-between gap-4"
  >
    <div>
      <h2 class="text-xl font-archivo font-bold text-accent-dark">
        Cloud Save
      </h2>
      <p class="text-sm text-accent-dark/80 mt-1">
        Sync game save data across devices. Saves are stored locally (v1). Enable
        per game and add save paths.
      </p>
    </div>
    <label
      class="flex items-center gap-2 cursor-pointer"
      style="flex-shrink: 0"
    >
      <span class="text-accent-dark font-medium">Enable cloud save</span>
      <input
        type="checkbox"
        class="w-5 h-5 rounded border-accent-dark text-accent"
        checked={config.enabled}
        onchange={(e) => setGlobalEnabled((e.target as HTMLInputElement).checked)}
      />
    </label>
  </div>

  {#if config.enabled}
    <div class="flex flex-col gap-4">
      <h3 class="text-lg font-archivo font-semibold text-accent-dark">
        Per-game settings
      </h3>
      {#each apps as app (app.appID)}
        {@const key = String(app.appID)}
        {@const perGame = config.perGame[key]}
        {@const isEnabled = perGame?.enabled ?? false}
        {@const isExpanded = expandedAppID === app.appID}
        <div
          class="bg-accent-lighter rounded-lg overflow-hidden"
          in:fly={{ y: 10, duration: 200, delay: 50 }}
        >
          <button
            class="w-full flex flex-row items-center justify-between p-4 border-none bg-transparent cursor-pointer text-left hover:bg-accent-light/30 transition-colors"
            onclick={() => toggleExpand(app.appID)}
          >
            <div class="flex items-center gap-3">
              <span
                class="cloudsave-expand-arrow text-accent-dark font-medium"
                class:expanded={isExpanded}
              >
                ▶
              </span>
              <span class="font-archivo font-semibold text-accent-dark">
                {app.name}
              </span>
              {#if isEnabled}
                <span
                  class="px-2 py-0.5 rounded text-xs bg-accent/20 text-accent-dark"
                >
                  {perGame?.paths?.length ?? 0} path(s)
                </span>
              {/if}
            </div>
            <label
              class="flex items-center gap-2 cursor-pointer"
              onclick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                class="w-4 h-4 rounded border-accent-dark text-accent"
                checked={isEnabled}
                onchange={(e) =>
                  setGameEnabled(app.appID, (e.target as HTMLInputElement).checked)}
              />
              <span class="text-sm text-accent-dark">Sync this game</span>
            </label>
          </button>
          {#if isExpanded}
            <div
              class="px-4 pb-4 pt-0 border-t border-accent-dark/10"
              in:fly={{ y: -5, duration: 200 }}
              out:fly={{ y: -5, duration: 150 }}
            >
              {#if isEnabled}
                <div class="mt-3 flex flex-col gap-2">
                  {#each perGame?.paths ?? [] as pathEntry, i}
                    <div
                      class="flex flex-row items-center gap-2 text-sm text-accent-dark"
                    >
                      <span class="font-medium">{pathEntry.name}:</span>
                      <span
                        class="flex-1 truncate min-w-0"
                        title={pathEntry.path}
                      >
                        {pathEntry.path}
                      </span>
                      <button
                        type="button"
                        class="px-2 py-1 rounded bg-red-500/20 text-red-700 hover:bg-red-500/30 border-none cursor-pointer text-xs"
                        onclick={() => removePath(app.appID, i)}
                        aria-label="Remove path"
                      >
                        Remove
                      </button>
                    </div>
                  {/each}
                  <div class="flex flex-row gap-2 mt-2">
                    <button
                      type="button"
                      class="px-3 py-2 rounded-lg bg-accent-light hover:bg-accent-light/80 text-accent-dark font-medium border-none cursor-pointer text-sm"
                      onclick={() => pickFolder(app.appID)}
                    >
                      Add save folder
                    </button>
                    <button
                      type="button"
                      class="px-3 py-2 rounded-lg bg-accent hover:bg-accent-dark text-white font-medium border-none cursor-pointer text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={syncingAppID === app.appID}
                      onclick={() => doSyncUp(app.appID)}
                    >
                      {syncingAppID === app.appID ? 'Syncing…' : 'Upload now'}
                    </button>
                    <button
                      type="button"
                      class="px-3 py-2 rounded-lg bg-accent-light hover:bg-accent-light/80 text-accent-dark font-medium border-none cursor-pointer text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={syncingAppID === app.appID}
                      onclick={() => doSyncDown(app.appID)}
                    >
                      Download now
                    </button>
                  </div>
                </div>
              {:else}
                <p class="text-sm text-accent-dark/70 mt-2">
                  Enable "Sync this game" and add at least one save path (folder).
                </p>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  @reference "../app.css";

  .cloudsave-settings {
    @apply px-2;
  }
  .cloudsave-expand-arrow {
    display: inline-block;
    transition: transform 0.2s;
  }
  .cloudsave-expand-arrow.expanded {
    transform: rotate(90deg);
  }
</style>
