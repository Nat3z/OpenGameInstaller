<script lang="ts">
  import type { LibraryInfo, SearchResult } from '@ogi-sdk/connect';
  import { ConfigurationBuilder } from 'ogi-addon/config';
  import PlayIcon from '@/frontend/Icons/PlayIcon.svelte';
  import {
    currentDownloads,
    currentStorePageOpened,
    currentStorePageOpenedStorefront,
    gamesLaunched,
    launchGameTrigger,
    launchOverlayPlayPageReady,
    setHeaderBackButton,
    clearHeaderBackButton,
    createNotification,
  } from '@/frontend/store.svelte';
  import { onDestroy, onMount, tick } from 'svelte';
  import SettingsFilled from '@/frontend/Icons/SettingsFilled.svelte';
  import GameConfiguration from '@/frontend/components/GameConfiguration.svelte';
  import { fly, slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import Image from '@/frontend/components/Image.svelte';
  import {
    addonServer,
    fetchAddonsWithConfigure,
    isAddonEventAvailable,
    runLaunchAppAddons,
    runTask,
  } from '@/frontend/utils';
  import AddonPicture from '@/frontend/components/AddonPicture.svelte';
  import { updatesManager, appUpdates } from '@/frontend/states.svelte';
  import UpdateIcon from '@/frontend/Icons/UpdateIcon.svelte';
  import UpdateAppModal from '@/frontend/components/built/UpdateAppModal.svelte';
  import { supportsStorefront } from '@/lib/storefronts';

  let updateInfo = $derived.by(() => {
    return updatesManager.getAppUpdate(libraryInfo.appID);
  });

  let hasActiveUpdateDownload = $derived(
    !!$currentDownloads.find(
      (download) =>
        download.appID === libraryInfo.appID &&
        download.status !== 'error' &&
        download.status !== 'completed' &&
        download.status !== 'seeding' &&
        download.status !== 'setup-complete'
    )
  );

  let isUpdateDismissed = $derived.by(() => {
    if (!updateInfo?.updateVersion) return false;
    return updatesManager.isAppUpdateDismissed(
      libraryInfo.appID,
      updateInfo.updateVersion
    );
  });

  let showUpdateModal = $state(false);

  interface Props {
    libraryInfo: LibraryInfo;
    exitPlayPage: () => void;
  }

  let { libraryInfo = $bindable(), exitPlayPage }: Props = $props();

  let requiresSteamReadd = $derived(
    appUpdates.requiredReadds.some((r) => r.appID === libraryInfo.appID)
  );
  let os = $state('');
  let isMigratingToUmu = $state(false);
  let needsUmuSetup = $derived.by(() => {
    const isLinux = os === 'linux';
    const isWindowsExecutable = libraryInfo.launchExecutable
      .toLowerCase()
      .endsWith('.exe');
    const needsUmu = !libraryInfo.umu;
    return isLinux && isWindowsExecutable && needsUmu;
  });
  let needsUmuMigration = $derived(needsUmuSetup);

  async function doesLinkExist(url: string | undefined) {
    if (!url) return false;
    const response = await window.electronAPI.app.axios({
      method: 'get',
      url: url,
      headers: {
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    return response.status === 200;
  }

  let playButton: HTMLButtonElement | undefined = $state(undefined);
  let openedGameConfiguration = $state(false);

  async function launchGame() {
    if ($gamesLaunched[libraryInfo.appID]) return;
    if (!playButton) return;
    console.log('Launching game with appID: ' + libraryInfo.appID);
    playButton.setAttribute('data-error', 'false');

    // Fire of the addon launch-app event first

    gamesLaunched.update((games) => {
      games[libraryInfo.appID] = 'launching';
      return games;
    });

    playButton.disabled = true;
    playButton.querySelector('svg')!!.style.display = 'none';
    playButton.querySelector('p')!!.textContent = 'WAITING';
    try {
      console.log('launching pre-launch');
      console.log('launchApp', libraryInfo);
      await runLaunchAppAddons(libraryInfo, 'pre');
    } catch (error) {
      console.error(error);
      // remove the game from the gamesLaunched state first so the play button is restored
      gamesLaunched.update((games) => {
        delete games[libraryInfo.appID];
        return games;
      });
      // wait for the DOM to update so playButton is restored
      await tick();
      if (playButton) {
        playButton.setAttribute('data-error', 'true');
      }
      return;
    }

    console.log('pre-launch complete');

    await window.electronAPI.app.launchGame('' + libraryInfo.appID);

    console.log('launchGame complete');
    if (!window.electronAPI.fs.exists('./internals')) {
      window.electronAPI.fs.mkdir('./internals');
      window.electronAPI.fs.write(
        './internals/apps.json',
        JSON.stringify([], null, 2)
      );
    }

    // reorders the recent launched apps to the front of the list
    if (window.electronAPI.fs.exists('./internals/apps.json')) {
      let appsOrdered: number[] = JSON.parse(
        window.electronAPI.fs.read('./internals/apps.json')
      );
      // remove the appID from the list
      appsOrdered = appsOrdered.filter((id) => id !== libraryInfo.appID);
      // add it to the front
      appsOrdered.unshift(libraryInfo.appID);
      window.electronAPI.fs.write(
        './internals/apps.json',
        JSON.stringify(appsOrdered, null, 2)
      );
    }
  }

  onMount(() => {
    launchOverlayPlayPageReady.set(libraryInfo.appID);
  });

  const unsubscribe2 = launchGameTrigger.subscribe((game) => {
    console.log('launchGameTrigger', libraryInfo.appID);
    if (game === libraryInfo.appID) {
      launchGame();
      launchGameTrigger.set(undefined);
    }
  });

  const unsubscribe = gamesLaunched.subscribe((games) => {
    if (!playButton) return;
    // wait for playButton to be defined
    if (!games[libraryInfo.appID]) {
      playButton.disabled = false;
      playButton.querySelector('p')!!.textContent = 'PLAY';
      playButton.querySelector('svg')!!.style.display = 'block';
      return;
    }
    if (games[libraryInfo.appID] === 'error') {
      console.log('Error launching game');
      playButton.disabled = false;
      playButton.querySelector('p')!!.textContent = 'ERROR';
      playButton.querySelector('svg')!!.style.display = 'none';
      return;
    }
    if (games[libraryInfo.appID] === 'launching') {
      playButton.disabled = true;
      playButton.querySelector('p')!!.textContent = 'WAITING';
      playButton.querySelector('svg')!!.style.display = 'none';
      return;
    }
    if (games[libraryInfo.appID] === 'launched') {
      playButton.disabled = true;
      playButton.querySelector('p')!!.textContent = 'PLAYING';
      playButton.querySelector('svg')!!.style.display = 'none';
    }
  });

  function openGameConfiguration() {
    openedGameConfiguration = true;
  }

  function onFinish(data: any) {
    openedGameConfiguration = false;
    // set the configuration for the game
    if (!data) return;
    libraryInfo.cwd = data.cwd;
    libraryInfo.launchExecutable = data.launchExecutable;
    libraryInfo.launchArguments = data.launchArguments;
    if (libraryInfo.umu && Array.isArray(data.dllOverrides)) {
      libraryInfo.umu = {
        ...libraryInfo.umu,
        dllOverrides:
          data.dllOverrides.length > 0 ? data.dllOverrides : undefined,
      };
    }
    window.electronAPI.fs.write(
      './library/' + libraryInfo.appID + '.json',
      JSON.stringify(libraryInfo, null, 2)
    );
  }

  onDestroy(() => {
    unsubscribe();
    unsubscribe2();
    clearHeaderBackButton();
  });

  function showUmuMigrationCompletePrompt() {
    document.dispatchEvent(
      new CustomEvent('input-asked', {
        detail: {
          config: new ConfigurationBuilder().build(false),
          id: `umu-migration-complete-${libraryInfo.appID}`,
          name: 'UMU Migration Complete',
          description:
            "Prefix migration is complete. Remove this game's existing Steam shortcut, then use Add to Steam in OpenGameInstaller so it can be re-added with UMU launch compatibility.",
        },
      })
    );
  }

  async function migrateToUmu() {
    if (isMigratingToUmu) return;
    isMigratingToUmu = true;

    try {
      const steamAppIdResult = await window.electronAPI.app.getSteamAppId(
        libraryInfo.appID
      );
      const oldSteamAppId = steamAppIdResult.success
        ? steamAppIdResult.appId
        : undefined;

      const migrationResult = await window.electronAPI.app.migrateToUmu(
        libraryInfo.appID,
        oldSteamAppId
      );

      if (!migrationResult.success) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: migrationResult.error || 'Failed to migrate game to UMU',
        });
        return;
      }

      const updatedLibraryInfo = await window.electronAPI.app.getLibraryInfo(
        libraryInfo.appID
      );
      if (updatedLibraryInfo) {
        libraryInfo = updatedLibraryInfo;
      }

      // Queue Steam re-add requirement so the existing banner appears
      // and persistence writes update-state.json automatically.
      appUpdates.requiredReadds = [
        ...appUpdates.requiredReadds.filter(
          (r) => r.appID !== libraryInfo.appID
        ),
        {
          appID: libraryInfo.appID,
          steamAppId: oldSteamAppId ?? 0,
        },
      ];

      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'success',
        message: 'Successfully migrated game prefix to UMU',
      });
      showUmuMigrationCompletePrompt();
    } catch (error) {
      console.error(error);
      createNotification({
        id: Math.random().toString(36).substring(7),
        type: 'error',
        message: 'Failed to migrate game to UMU',
      });
    } finally {
      isMigratingToUmu = false;
    }
  }

  let searchingAddons: { [key: string]: SearchResult[] | undefined } = $state(
    {}
  );
  let addonsMap: Map<string, { id: string; name: string }> = $state(new Map());
  let collapsedAddons: Set<string> = $state(new Set());

  function toggleAddonCollapse(addonId: string) {
    if (collapsedAddons.has(addonId)) {
      collapsedAddons.delete(addonId);
    } else {
      collapsedAddons.add(addonId);
    }
    collapsedAddons = new Set(collapsedAddons);
  }
  let settledAddons = $derived.by(() => {
    return (
      Object.values(searchingAddons).filter((task) => task !== undefined)
        .length === Object.keys(searchingAddons).length
    );
  });

  $effect(() => {
    console.log('searchingAddons', searchingAddons);
    console.log('settledAddons', settledAddons);
  });

  onMount(async () => {
    os = await window.electronAPI.app.getOS();

    // Set up the header back button
    console.log('PlayPage mounted, setting header back button');
    setHeaderBackButton(() => {
      console.log('Header back button clicked');
      exitPlayPage();
    }, 'Back to library');

    const addons = await fetchAddonsWithConfigure();
    addonsMap = new Map(
      addons.map((addon) => [addon.id, { id: addon.id, name: addon.name }])
    );
    const addonsWithStorefront = addons.filter(
      (addon) =>
        supportsStorefront(addon.storefronts, libraryInfo.storefront) &&
        isAddonEventAvailable(addon, 'search')
    );

    if (addonsWithStorefront.length === 0) return;
    for (const addon of addonsWithStorefront) {
      searchingAddons[addon.id] = undefined;
      (
        addonServer.addon(addon.id).search({
          appID: libraryInfo.appID,
          storefront: libraryInfo.storefront,
          for: 'task',
        }) as Promise<SearchResult[]>
      )
        .then((tasks) => {
          console.log('tasks', tasks);
          searchingAddons[addon.id] = tasks;
        })
        .catch((ex) => {
          console.error(ex);
          searchingAddons[addon.id] = [];
        });
    }
    await Promise.allSettled(
      Object.values(searchingAddons).map((task) => task)
    );
  });

  function handleRunTask(task: SearchResult, addonID: string) {
    console.log('Running task: ' + task.name);
    const addon = addonsMap.get(addonID);
    runTask(
      {
        ...task,
        addonSource: addonID,
        addonName: addon?.name || addonID,
        coverImage: libraryInfo.coverImage,
        storefront: libraryInfo.storefront,
        capsuleImage: libraryInfo.capsuleImage,
      },
      libraryInfo.cwd,
      libraryInfo
    );
  }
</script>

{#if openedGameConfiguration}
  <GameConfiguration gameInfo={libraryInfo} {onFinish} {exitPlayPage} />
{/if}

{#if showUpdateModal && updateInfo}
  <UpdateAppModal
    {libraryInfo}
    updateVersion={updateInfo.updateVersion}
    onClose={() => (showUpdateModal = false)}
  />
{/if}

<div
  class="absolute top-0 left-0 z-3 flex h-full w-full flex-col overflow-hidden bg-background-color animate-fade-in-pop-fast"
  out:fly={{ x: 100, duration: 500, easing: quintOut }}
>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <!-- Hero Banner Section -->
    <div class="relative h-64 w-full shrink-0 overflow-hidden">
      <Image
        classifier={libraryInfo.appID.toString() + '-cover'}
        src={libraryInfo.coverImage}
        alt={libraryInfo.name}
        class="h-full w-full object-cover rounded-t-lg rounded-b-none"
      />
      <!-- Overlay with game info -->
      <div
        class="absolute bottom-0 left-0 right-0 p-6"
        style="background: linear-gradient(to top, var(--color-overlay-bg), transparent);"
      >
        <h1 class="mb-2 text-4xl font-archivo font-bold text-overlay-text">
          {libraryInfo.name}
        </h1>
      </div>

      <!-- Title image overlay if available -->
      {#await doesLinkExist(libraryInfo.titleImage)}
        <div class="absolute z-2 h-full w-full"></div>
      {:then result}
        {#if result}
          <img
            src={libraryInfo.titleImage}
            alt="logo"
            class="absolute top-1/2 left-1/2 z-3 max-h-32 max-w-xs -translate-x-1/2 -translate-y-1/2 transform object-contain drop-shadow-lg"
          />
        {/if}
      {/await}
    </div>

    <!-- Action Buttons -->
    <div class="sticky top-0 z-10 shrink-0 pb-2">
      <div
        class="flex flex-wrap items-center gap-3 rounded-b-lg bg-accent-lighter px-6 py-4 backdrop-blur-sm"
      >
        {#if updateInfo && !hasActiveUpdateDownload && !isUpdateDismissed}
          <button
            class="flex items-center justify-center gap-2 rounded-lg border-none bg-success px-6 py-3 text-overlay-text transition-colors duration-200 hover:bg-success-hover disabled:cursor-not-allowed disabled:bg-disabled"
            onclick={() => (showUpdateModal = true)}
          >
            <UpdateIcon fill="var(--color-overlay-text)" />
            <p class="font-archivo font-semibold text-overlay-text">
              Update to {updateInfo.updateVersion?.slice(0, 8)}
            </p>
          </button>
          <button
            aria-label="Ignore update"
            onclick={() => {
              if (!updateInfo?.updateVersion) return;
              updatesManager.dismissAppUpdate(
                libraryInfo.appID,
                updateInfo.updateVersion
              );
            }}
            class="flex items-center justify-center gap-2 rounded-lg border-none bg-error px-3 py-3 text-overlay-text transition-colors duration-200 hover:bg-error-hover disabled:cursor-not-allowed disabled:bg-disabled"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="20px"
              viewBox="0 -960 960 960"
              width="20px"
              fill="var(--color-overlay-text)"
            >
              <path
                d="M480-424 284-228q-17 17-44 17t-44-17q-17-17-17-44t17-44l196-196-196-196q-17-17-17-44t17-44q17-17 44-17t44 17l196 196 196-196q17-17 44-17t44 17q17 17 17 44t-17 44L536-480l196 196q17 17 17 44t-17 44q-17 17-44 17t-44-17L480-424Z"
              />
            </svg>
          </button>
        {:else if hasActiveUpdateDownload}
          <button
            class="flex items-center justify-center gap-2 rounded-lg border-none bg-success px-6 py-3 text-overlay-text transition-colors duration-200 cursor-not-allowed"
            disabled
          >
            <UpdateIcon fill="var(--color-overlay-text)" />
            <p class="font-archivo font-semibold text-overlay-text">Updating</p>
          </button>
        {:else if os === ''}
          <div
            class="flex h-full min-h-11 w-full items-center justify-center"
          ></div>
        {:else if needsUmuSetup}
          <div class="relative group">
            <button
              class="flex items-center justify-center gap-2 rounded-lg border-none bg-disabled px-6 py-3 transition-colors duration-200 disabled:cursor-not-allowed disabled:bg-disabled"
              disabled
            >
              <PlayIcon fill="var(--color-overlay-text)" />
              <p class="font-archivo font-semibold text-white">Play</p>
            </button>
            <div
              class="pointer-events-none absolute top-full left-0 z-10 mt-2 flex flex-row items-center gap-2 whitespace-nowrap rounded-lg border border-accent-dark bg-accent-lighter px-3 py-2 text-sm text-accent-dark opacity-0 drop-shadow-md transition-opacity duration-200 group-hover:opacity-100"
            >
              <img src="./error.svg" alt="error" class="h-4 w-4" />
              <p class="pr-4 font-archivo font-semibold text-accent-dark">
                You can only play Windows games through Steam using Proton or
                UMU
              </p>
            </div>
          </div>
        {:else if $gamesLaunched[libraryInfo.appID] === 'launching'}
          <button
            class="flex items-center justify-center gap-2 rounded-lg border-none bg-success px-6 py-3 text-overlay-text transition-colors duration-200 cursor-not-allowed"
            disabled
          >
            <p class="font-archivo font-semibold text-overlay-text">WAITING</p>
          </button>
        {:else if $gamesLaunched[libraryInfo.appID] === 'launched'}
          <button
            class="flex items-center justify-center gap-2 rounded-lg border-none bg-success px-6 py-3 text-overlay-text transition-colors duration-200 cursor-not-allowed"
            disabled
          >
            <p class="font-archivo font-semibold text-overlay-text">PLAYING</p>
          </button>
        {:else}
          <button
            bind:this={playButton}
            class="flex items-center justify-center gap-2 rounded-lg border-none bg-success px-6 py-3 text-overlay-text transition-colors duration-200 hover:bg-success-hover data-[error=true]:bg-error data-[error=true]:hover:bg-error-hover/50 disabled:cursor-not-allowed disabled:bg-disabled"
            onclick={() => launchGameTrigger.set(libraryInfo.appID)}
          >
            <PlayIcon fill="var(--color-overlay-text)" />
            <p class="font-archivo font-semibold text-overlay-text">PLAY</p>
          </button>
        {/if}

        {#if updateInfo && !hasActiveUpdateDownload && isUpdateDismissed}
          <button
            aria-label="Open update options"
            title="Open update options"
            class="flex items-center justify-center rounded-lg border-none bg-success px-3 py-3 text-overlay-text transition-colors duration-200 hover:bg-success-hover"
            onclick={() => (showUpdateModal = true)}
          >
            <UpdateIcon
              fill="var(--color-overlay-text)"
              width="20px"
              height="20px"
            />
          </button>
        {/if}

        <button
          class="flex items-center justify-center gap-2 rounded-lg border-none bg-accent-light px-4 py-3 text-accent-dark transition-colors duration-200 hover:bg-accent-light/80"
          onclick={openGameConfiguration}
        >
          <SettingsFilled fill="var(--color-accent-dark)" />
          <span class="font-medium">Settings</span>
        </button>

        <button
          class="flex items-center justify-center gap-2 rounded-lg border-none bg-accent-light px-4 py-3 text-accent-dark transition-colors duration-200 hover:bg-accent-light/80"
          onclick={() => {
            currentStorePageOpened.set(libraryInfo.appID);
            currentStorePageOpenedStorefront.set(libraryInfo.storefront);
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            class="h-5 w-5 fill-accent-dark"
          >
            <path
              d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 17C11.45 17 11 16.55 11 16V12C11 11.45 11.45 11 12 11C12.55 11 13 11.45 13 12V16C13 16.55 12.55 17 12 17ZM13 9H11V7H13V9Z"
            />
          </svg>
          <span class="font-medium">More Info</span>
        </button>
      </div>
    </div>

    <div class="space-y-3 px-3 pb-6">
      {#if needsUmuMigration}
        <div
          class="mx-0 flex flex-col gap-3 rounded-lg bg-accent-lighter p-5"
          in:fly={{ y: -20, duration: 300 }}
        >
          <div class="flex items-start gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              class="mt-0.5 h-6 w-6 shrink-0 fill-accent-dark"
            >
              <path
                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
              />
            </svg>
            <div>
              <h3 class="text-base font-archivo font-bold text-accent-dark">
                UMU Migration Recommended
              </h3>
              <p class="text-sm text-accent-dark">
                This game is still using legacy Proton prefix mode. Migrate it
                to UMU for native OGI launch compatibility, including pre/post
                launch events support.
              </p>
            </div>
          </div>
          <div class="flex gap-3">
            <button
              class="flex flex-1 items-center justify-center gap-2 rounded-lg border-none bg-accent-light px-4 py-2 font-archivo font-semibold text-accent-dark transition-colors duration-200 hover:bg-accent-light/80 disabled:cursor-not-allowed disabled:bg-disabled/50"
              onclick={migrateToUmu}
              disabled={isMigratingToUmu}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                class="h-5 w-5 fill-accent-dark"
              >
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
              </svg>
              {isMigratingToUmu ? 'Migrating...' : 'Migrate to UMU'}
            </button>
          </div>
        </div>
      {/if}

      <!-- Steam Re-add Banner -->
      {#if requiresSteamReadd}
        <div
          class="mx-0 flex flex-col gap-3 rounded-lg bg-accent-lighter p-5"
          in:fly={{ y: -20, duration: 300 }}
        >
          <div class="flex items-start gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              class="mt-0.5 h-6 w-6 shrink-0 fill-accent-dark"
            >
              <path
                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
              />
            </svg>
            <div>
              <h3 class="text-base font-archivo font-bold text-accent-dark">
                Steam Re-add Required
              </h3>
              <p class="text-sm text-accent-dark">
                This game has been updated. To continue playing, you must re-add
                it to Steam.
              </p>
            </div>
          </div>
          <div class="flex gap-3">
            <button
              class="flex flex-1 items-center justify-center gap-2 rounded-lg border-none bg-accent-light px-4 py-2 font-archivo font-semibold text-accent-dark transition-colors duration-200 hover:bg-accent-light/80 disabled:cursor-not-allowed disabled:bg-disabled/50"
              onclick={async (event) => {
                const button = event.currentTarget as HTMLButtonElement;
                try {
                  button.disabled = true;

                  // Get the old Steam app ID from requiredReadds if available
                  const requiredReadd = appUpdates.requiredReadds.find(
                    (r) => r.appID === libraryInfo.appID
                  );
                  const oldSteamAppId =
                    requiredReadd?.steamAppId && requiredReadd.steamAppId !== 0
                      ? requiredReadd.steamAppId
                      : undefined;

                  await window.electronAPI.app.addToSteam(
                    libraryInfo.appID,
                    oldSteamAppId
                  );

                  // Only remove from requiredReadds on success
                  appUpdates.requiredReadds = appUpdates.requiredReadds.filter(
                    (r) => r.appID !== libraryInfo.appID
                  );
                } catch (error) {
                  console.error(error);
                  // Re-enable button on error
                  button.disabled = false;
                }
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                class="h-5 w-5 fill-accent-dark"
              >
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
              </svg>
              Add to Steam
            </button>
          </div>
        </div>
      {/if}

      <!-- Addon Task Table -->
      {#if settledAddons}
        <div class="space-y-3">
          {#each Object.keys(searchingAddons) as addonID, index}
            {@const tasks = searchingAddons[addonID]!!.filter(
              (task) => task.downloadType === 'task'
            )}
            {#if tasks.length > 0}
              <div in:fly={{ y: 30, duration: 400, delay: 50 * index }}>
                <button
                  class="mb-1 w-full cursor-pointer rounded-lg border-none bg-transparent px-3 py-2 transition-colors duration-200 hover:bg-accent-lighter active:bg-accent-light/80"
                  onclick={() => toggleAddonCollapse(addonID)}
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2">
                      <AddonPicture addonId={addonID} class="h-6 w-6 rounded" />
                      <span class="text-sm font-medium text-accent-dark"
                        >{addonsMap.get(addonID)?.name ?? addonID}</span
                      >
                    </div>
                    <svg
                      class="h-3.5 w-3.5 text-accent-dark/60 transition-transform duration-200"
                      class:rotate-180={!collapsedAddons.has(addonID)}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </div>
                </button>

                {#if !collapsedAddons.has(addonID)}
                  <div
                    class="overflow-hidden rounded-lg bg-accent-lighter"
                    transition:slide={{ duration: 300 }}
                  >
                    {#each tasks as task, taskIndex}
                      <div
                        class="flex flex-row items-center justify-between px-4 py-3 {taskIndex <
                        tasks.length - 1
                          ? 'border-b border-accent-light/40'
                          : ''}"
                      >
                        <span class="font-medium text-accent-dark"
                          >{task.name}</span
                        >
                        <button
                          class="rounded-lg bg-accent-light px-4 py-1.5 text-sm text-accent-dark transition-colors duration-200 hover:bg-accent-light/80 border-none"
                          onclick={() => handleRunTask(task, addonID)}
                          >Run</button
                        >
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {:else}
        <div class="overflow-hidden rounded-lg bg-accent-lighter animate-pulse">
          {#each Array(3) as _, i}
            <div
              class="flex flex-row items-center justify-between px-4 py-3 {i < 2
                ? 'border-b border-accent-light/40'
                : ''}"
            >
              <div class="h-5 w-40 rounded bg-accent-light"></div>
              <div class="h-8 w-16 rounded-lg bg-accent-light"></div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
