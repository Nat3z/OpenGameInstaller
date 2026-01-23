<script lang="ts">
  import type { LibraryInfo } from 'ogi-addon';
  import {
    ConfigurationBuilder,
    type BooleanOption,
    type ConfigurationFile,
    type ConfigurationOption,
    type NumberOption,
    type StringOption,
  } from 'ogi-addon/config';
  import { createNotification, currentDownloads } from '../store';
  import { appUpdates } from '../states.svelte';
  import Modal from './modal/Modal.svelte';
  import TitleModal from './modal/TitleModal.svelte';
  import SectionModal from './modal/SectionModal.svelte';
  import ButtonModal from './modal/ButtonModal.svelte';
  import InputModal from './modal/InputModal.svelte';
  import CheckboxModal from './modal/CheckboxModal.svelte';

  interface Props {
    exitPlayPage: () => void;
    gameInfo: LibraryInfo;
    onFinish: (data: { [key: string]: any } | undefined) => void;
  }

  let { exitPlayPage, gameInfo, onFinish }: Props = $props();

  let platform = $state<string>('');

  // Get OS platform
  $effect(() => {
    window.electronAPI.app.getOS().then((os) => {
      platform = os;
    });
  });

  function isStringOption(option: ConfigurationOption): option is StringOption {
    return option.type === 'string';
  }

  function isNumberOption(option: ConfigurationOption): option is NumberOption {
    return option.type === 'number';
  }

  function isBooleanOption(
    option: ConfigurationOption
  ): option is BooleanOption {
    return option.type === 'boolean';
  }

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
        if (option.allowedValues.length > 0) {
          formData[key] = option.defaultValue || option.allowedValues[0];
        } else {
          formData[key] = option.defaultValue ?? '';
        }
      }
    });
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
      // Check if prefix move is needed before adding to Steam
      if (platform === 'linux' && appUpdates.prefixMoveInfo[gameInfo.appID]) {
        const prefixInfo = appUpdates.prefixMoveInfo[gameInfo.appID];
        const { exists, prefixPath } =
          await window.electronAPI.app.checkPrefixExists(gameInfo.appID);
        const currentPrefix = exists ? (prefixPath ?? '') : '';

        // If current prefix is different from original, move it
        if (
          currentPrefix !== prefixInfo.originalPrefix &&
          currentPrefix !== '' &&
          prefixInfo.originalPrefix !== ''
        ) {
          createNotification({
            id: Math.random().toString(36).substring(7),
            type: 'info',
            message: `Swapping wine prefixes to maintain save data...`,
          });
          const result = await window.electronAPI.app.movePrefix(
            prefixInfo.originalPrefix,
            prefixInfo.gameName
          );
          if (result !== 'success') {
            throw new Error('Failed to move prefix');
          }
        }

        // Clean up the stored prefix info
        delete appUpdates.prefixMoveInfo[gameInfo.appID];
      }

      await window.electronAPI.app.addToSteam(gameInfo.appID);

      // Remove from requiredReadds if it was there
      appUpdates.requiredReadds = appUpdates.requiredReadds.filter(
        (id) => id !== gameInfo.appID
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
    option: ConfigurationOption
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

  function getInputValue(key: string, option: ConfigurationOption) {
    const value = formData[key];
    if (isBooleanOption(option)) return undefined; // Handled by CheckboxModal
    return value;
  }

  function getInputOptions(option: ConfigurationOption): string[] {
    if (isStringOption(option)) {
      return option.allowedValues;
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
          class="mb-4"
          onchange={handleInputChange}
        />
      {/if}
    {/each}

    <SectionModal class="mt-4">
      <div class="flex gap-3 flex-row">
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
    </SectionModal>
  </Modal>
{/if}
