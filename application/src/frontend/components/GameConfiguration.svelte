<script lang="ts">
  import type {
    ConfigurationFile,
    ConfigurationOptionWire,
    LibraryInfo,
  } from '@ogi-sdk/connect';
  import {
    ConfigurationBuilder,
    isBooleanOption,
    isNumberOption,
    isStringOption,
  } from 'ogi-addon/config';
  import {
    createNotification,
    currentDownloads,
  } from '@/frontend/store.svelte';
  import { appUpdates } from '@/frontend/states.svelte';
  import Modal from '@/frontend/components/modal/Modal.svelte';
  import TitleModal from '@/frontend/components/modal/TitleModal.svelte';
  import ButtonModal from '@/frontend/components/modal/ButtonModal.svelte';
  import InputModal from '@/frontend/components/modal/InputModal.svelte';
  import CheckboxModal from '@/frontend/components/modal/CheckboxModal.svelte';
  import WineDllOverridesModal from '@/frontend/components/modal/WineDllOverridesModal.svelte';

  interface Props {
    exitPlayPage: () => void;
    gameInfo: LibraryInfo;
    onFinish: (data: { [key: string]: any } | undefined) => void;
  }

  let { exitPlayPage, gameInfo, onFinish }: Props = $props();

  let platform = $state<string>('');
  let showDllOverridesModal = $state(false);

  // Get OS platform
  $effect(() => {
    window.electronAPI.app.getOS().then((os) => {
      platform = os;
    });
  });

  let screenRendering: ConfigurationFile = new ConfigurationBuilder()
    .addStringOption((option) =>
      option
        .setDisplayName('Game Path')
        .setName('cwd')
        .setDescription('The path to the game executable')
        .setInputType('folder')
        .setDefaultValue(gameInfo.cwd ?? 'C:\\Program Files\\Game')
    )
    .addStringOption((option) =>
      option
        .setDisplayName('Game Executable')
        .setName('launchExecutable')
        .setDescription('The game executable path')
        .setInputType('file')
        .setDefaultValue(gameInfo.launchExecutable ?? 'game.exe')
    )
    .addStringOption((option) =>
      option
        .setDisplayName('Game Arguments')
        .setName('launchArguments')
        .setDescription('%command% replaces with the game executable.')
        .setInputType('text')
        .setDefaultValue(gameInfo.launchArguments ?? '%command%')
    )
    .build(false);

  let formData: { [key: string]: any } = $state({});

  // Initialize form data with default values
  $effect(() => {
    Object.keys(screenRendering).forEach((key) => {
      const option = screenRendering[key];
      if (isBooleanOption(option)) {
        formData[key] = option.defaultValue ?? false;
      } else if (isNumberOption(option)) {
        formData[key] = option.defaultValue ?? option.min;
      } else if (isStringOption(option)) {
        if ((option.allowedValues?.length ?? 0) > 0) {
          formData[key] = option.defaultValue ?? option.allowedValues![0];
        } else {
          formData[key] = option.defaultValue ?? '';
        }
      }
    });

    formData.dllOverrides = [...(gameInfo.umu?.dllOverrides ?? [])];
  });

  function handleInputChange(id: string, value: string | number | boolean) {
    formData[id] = value;
  }

  function pushChanges() {
    onFinish(formData);
  }

  function closeModal() {
    onFinish(undefined);
  }

  function openDllOverridesModal() {
    showDllOverridesModal = true;
  }

  function handleDllOverridesSave(dllOverrides: string[]) {
    formData.dllOverrides = dllOverrides;
  }

  let canEditDllOverrides = $derived(
    (platform === 'linux' || platform === 'darwin') && !!gameInfo.umu
  );
  let dllOverridesCount = $derived.by(() => {
    const dllOverrides = Array.isArray(formData.dllOverrides)
      ? formData.dllOverrides
      : [];
    return dllOverrides.length;
  });

  async function removeFromList() {
    await window.electronAPI.app.removeApp(gameInfo.appID);
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: 'Game removed from library. (Not deleted from disk)',
      type: 'success',
    });
    // remove the download from the downloads list
    currentDownloads.update((downloads) =>
      downloads.filter((download) => download.appID !== gameInfo.appID)
    );
    exitPlayPage();
  }

  async function addToSteam(button: HTMLButtonElement) {
    button.disabled = true;
    try {
      // Get the old Steam app ID from requiredReadds if available
      const requiredReadd = appUpdates.requiredReadds.find(
        (r) => r.appID === gameInfo.appID
      );
      const oldSteamAppId =
        requiredReadd?.steamAppId && requiredReadd.steamAppId !== 0
          ? requiredReadd.steamAppId
          : undefined;

      await window.electronAPI.app.addToSteam(gameInfo.appID, oldSteamAppId);

      // Remove from requiredReadds if it was there
      appUpdates.requiredReadds = appUpdates.requiredReadds.filter(
        (r) => r.appID !== gameInfo.appID
      );
    } catch (error) {
      console.error(error);
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Failed to add game to Steam',
        type: 'error',
      });
    }
    button.disabled = false;
  }

  function getInputType(
    option: ConfigurationOptionWire
  ): 'text' | 'password' | 'number' | 'range' | 'select' | 'file' | 'folder' {
    if (isStringOption(option)) {
      if (option.allowedValues && option.allowedValues.length > 0)
        return 'select';
      if (option.inputType === 'file') return 'file';
      if (option.inputType === 'folder') return 'folder';
      if (option.inputType === 'password') return 'password';
      return 'text';
    }
    if (isNumberOption(option)) {
      return option.inputType === 'range' ? 'range' : 'number';
    }
    return 'text';
  }

  function getInputValue(key: string, option: ConfigurationOptionWire) {
    const value = formData[key];
    if (isBooleanOption(option)) return undefined; // Handled by CheckboxModal
    return value;
  }

  function getInputOptions(option: ConfigurationOptionWire): string[] {
    if (isStringOption(option)) {
      return option.allowedValues ?? [];
    }
    return [];
  }
</script>

{#if Object.keys(formData).length > 0}
  <Modal open={true} size="large" onClose={closeModal}>
    <TitleModal title={gameInfo.name} />

    {#each Object.keys(screenRendering) as key}
      {#if isBooleanOption(screenRendering[key])}
        <CheckboxModal
          id={key}
          label={screenRendering[key].displayName}
          description={screenRendering[key].description}
          checked={formData[key]}
          class="mb-4"
          onchange={handleInputChange}
        />
      {:else}
        <InputModal
          id={key}
          label={screenRendering[key].displayName}
          description={screenRendering[key].description}
          type={getInputType(screenRendering[key])}
          value={getInputValue(key, screenRendering[key])}
          options={getInputOptions(screenRendering[key]).map((value) => ({
            id: value,
            name: value,
          }))}
          class="mb-4 {key === 'launchArguments' ? 'inline' : ''}"
          onchange={handleInputChange}
        />
        {#if key === 'launchArguments'}
          {#if platform === 'linux' || platform === 'darwin'}
            <ButtonModal
              text={dllOverridesCount > 0
                ? `DLL Overrides (${dllOverridesCount})`
                : 'DLL Overrides'}
              variant="secondary"
              onclick={openDllOverridesModal}
              disabled={!canEditDllOverrides}
            />
          {/if}
        {/if}
      {/if}
    {/each}

    <div class="pt-4 flex flex-row flex-wrap gap-3">
      <ButtonModal text="Save" variant="primary" onclick={pushChanges} />
      {#if platform === 'linux' || platform === 'darwin'}
        <ButtonModal
          text="Add to Steam"
          variant="secondary"
          onclick={(event) => {
            addToSteam(event.currentTarget as HTMLButtonElement);
          }}
        />
      {/if}
      <ButtonModal
        text="Remove Game"
        variant="danger"
        onclick={removeFromList}
      />
      <ButtonModal text="Cancel" variant="secondary" onclick={closeModal} />
    </div>
  </Modal>

  <WineDllOverridesModal
    open={showDllOverridesModal}
    initialOverrides={formData.dllOverrides ?? []}
    onSave={handleDllOverridesSave}
    onClose={() => (showDllOverridesModal = false)}
  />
{/if}
