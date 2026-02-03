<script lang="ts">
  import { onMount } from 'svelte';
  import { safeFetch, runTask } from '../utils';
  import type {
    BooleanOption,
    ConfigurationFile,
    ConfigurationOption,
    NumberOption,
    StringOption,
    ActionOption,
  } from 'ogi-addon/config';
  import { isActionOption } from 'ogi-addon/config';
  import type { OGIAddonConfiguration } from 'ogi-addon';
  import { notifications } from '../store';
  import AddonPicture from '../components/AddonPicture.svelte';
  import Modal from '../components/modal/Modal.svelte';
  import HeaderModal from '../components/modal/HeaderModal.svelte';
  import TitleModal from '../components/modal/TitleModal.svelte';
  import TextModal from '../components/modal/TextModal.svelte';
  import ButtonModal from '../components/modal/ButtonModal.svelte';
  import DeleteAddonWarningModal from '../components/built/DeleteAddonWarningModal.svelte';
  import CustomDropdown from '../components/CustomDropdown.svelte';

  const fs = window.electronAPI.fs;

  let {
    addonId,
    onBack,
    refreshAddon,
  }: { addonId: string; onBack: () => void; refreshAddon: () => void } =
    $props();

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

  interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
    configTemplate: ConfigurationFile;
  }

  let selectedAddon: ConfigTemplateAndInfo | null = $state(null);
  let deleteConfirmationModalOpen: boolean = $state(false);
  let backConfirmationModalOpen: boolean = $state(false);
  let selectedValues: Record<string, string> = $state({});

  onMount(() => {
    safeFetch('getAllAddons', {}).then((data) => {
      const addon = data.find((a: ConfigTemplateAndInfo) => a.id === addonId);
      if (addon) {
        selectedAddon = addon;
        if (selectedAddon) {
          Object.keys(selectedAddon.configTemplate).forEach((key) => {
            if (
              isStringOption(selectedAddon!.configTemplate[key]) &&
              selectedAddon!.configTemplate[key].allowedValues.length > 0
            ) {
              selectedValues[key] = getStoredOrDefaultValue(key);
            }
          });
        }
        setTimeout(() => {
          updateConfig();
        }, 100);
      }
    });
  });

  function updateConfig() {
    if (!selectedAddon) return;
    let config: Record<string, string | number | boolean> = {};
    Object.keys(selectedAddon.configTemplate).forEach((key) => {
      const option = selectedAddon!.configTemplate[key];
      const element = document.getElementById(key) as
        | HTMLInputElement
        | HTMLSelectElement;

      if (element) {
        if (isStringOption(option)) {
          if (option.allowedValues.length > 0) {
            config[key] = selectedValues[key];
          } else {
            config[key] = element.value;
          }
        } else if (isNumberOption(option)) {
          config[key] = parseInt(element.value);
        } else if (isBooleanOption(option) && element.type === 'checkbox') {
          config[key] = element.checked;
        }
      }
    });

    document.querySelectorAll('[data-error-message]').forEach((element) => {
      element.textContent = '';
      element.setAttribute('data-context', '');
      const inputElement =
        element.parentElement!!.querySelector('[data-input]');
      if (inputElement) {
        inputElement.classList.remove(
          'outline-red-500',
          'outline-2',
          'outline'
        );
      }
    });

    safeFetch(
      'updateConfig',
      {
        addonID: selectedAddon.id,
        config: config,
      },
      {}
    ).then((data) => {
      if (!data.success) {
        for (const key in data.errors) {
          const element = document.getElementById(key);
          if (!element) return console.error('element not found');
          const inputElement = element.matches('[data-input]')
            ? element
            : element
                .closest('[data-input-parent]')
                ?.querySelector('[data-input]');

          if (inputElement) {
            inputElement.classList.add(
              'outline-red-500',
              'outline-2',
              'outline'
            );
          }

          const errorMessageElement = element.parentElement!!.querySelector(
            '[data-error-message]'
          );
          if (errorMessageElement) {
            errorMessageElement.innerHTML = `<img src="./error.svg" alt="error" class="w-6 h-6" />`;
            errorMessageElement.setAttribute('data-context', data.errors[key]);
          }
        }
        notifications.update((update) => [
          ...update,
          {
            id: Math.random().toString(36).substring(7),
            type: 'error',
            message:
              'Failed to validate configuration. Configuration will not be usable.',
          },
        ]);
      }
    });
    fs.write('./config/' + selectedAddon.id + '.json', JSON.stringify(config));
  }

  function getStoredOrDefaultValue(key: string): any {
    if (!selectedAddon) return undefined;
    if (!fs.exists('./config/' + selectedAddon.id + '.json')) {
      return selectedAddon.configTemplate[key].defaultValue;
    } else {
      const storedConfig = JSON.parse(
        fs.read('./config/' + selectedAddon.id + '.json')
      );
      return storedConfig.hasOwnProperty(key)
        ? storedConfig[key]
        : selectedAddon.configTemplate[key].defaultValue;
    }
  }

  function browseForFolder(event: MouseEvent, type: 'file' | 'folder') {
    const dialog = window.electronAPI.fs.dialog;
    const element = (event.target as HTMLElement).parentElement!!.querySelector(
      'input'
    ) as HTMLInputElement;
    dialog
      .showOpenDialog({
        properties: type === 'file' ? ['openFile'] : ['openDirectory'],
      })
      .then((result) => {
        if (result && result.length > 0) {
          if (element) {
            element.value = result[0];
          }
          updateConfig();
        }
      });
  }

  function showDescription(event: MouseEvent | FocusEvent) {
    const element = event.target as HTMLElement;
    const contextual = element.parentElement!!.querySelector(
      '[data-description]'
    )!! as HTMLDivElement;
    contextual.style.display = 'flex';
    contextual.animate(
      [
        { opacity: 0, transform: 'translateY(-8px) scale(0.95)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ],
      {
        duration: 150,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards',
      }
    );
  }

  function hideDescription(event: MouseEvent) {
    const element = event.target as HTMLElement;
    const contextual = element.parentElement!!.querySelector(
      '[data-description]'
    )!! as HTMLDivElement;
    contextual.animate(
      [
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: 'translateY(-8px) scale(0.95)' },
      ],
      {
        duration: 150,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards',
      }
    );
    setTimeout(() => {
      contextual.style.display = 'none';
    }, 150);
  }

  function showContextHint(event: MouseEvent) {
    const element = event.target as HTMLElement;
    const context = element.getAttribute('data-context');
    if (!context) return;
    const contextual = element.parentElement!!.querySelector(
      '[data-contextual]'
    )!! as HTMLDivElement;
    contextual.style.display = 'flex';

    const hint = contextual.querySelector('p')!!;
    hint.textContent = context;
    contextual.animate(
      [
        { opacity: 0, transform: 'translateY(-8px) scale(0.95)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ],
      {
        duration: 150,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards',
      }
    );
  }

  function hideContextHint(event: MouseEvent) {
    const element = event.target as HTMLElement;
    const contextual = element.parentElement!!.querySelector(
      '[data-contextual]'
    )!! as HTMLDivElement;
    contextual.animate(
      [
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: 'translateY(-8px) scale(0.95)' },
      ],
      {
        duration: 150,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards',
      }
    );
    setTimeout(() => {
      contextual.style.display = 'none';
    }, 150);
  }

  function updateInputNum(element: HTMLInputElement) {
    if (element.type === 'range') {
      (element.parentElement!!.querySelector(
        '.range-value'
      ) as HTMLInputElement)!!.value = element.value;
    }
  }

  async function deleteAddon() {
    deleteConfirmationModalOpen = true;
  }

  async function deleteAddonGO() {
    if (!selectedAddon) return;
    try {
      const result = await safeFetch('deleteAddon', {
        addonID: selectedAddon.id,
      });
      if (result.success) {
        notifications.update((update) => [
          ...update,
          {
            id: Math.random().toString(36).substring(7),
            type: 'success',
            message: `Addon '${selectedAddon!.name}' deleted successfully.`,
          },
        ]);
        refreshAddon();
        onBack();
      } else {
        notifications.update((update) => [
          ...update,
          {
            id: Math.random().toString(36).substring(7),
            type: 'error',
            message:
              result.message ||
              `Failed to delete addon '${selectedAddon!.name}'.`,
          },
        ]);
      }
    } catch (e) {
      notifications.update((update) => [
        ...update,
        {
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: `Error deleting addon: ${e}`,
        },
      ]);
    }
  }

  function hasConfigErrors() {
    return Array.from(document.querySelectorAll('[data-error-message]')).some(
      (el) =>
        el.getAttribute('data-context') &&
        el.getAttribute('data-context') !== ''
    );
  }

  function handleBackClick() {
    if (hasConfigErrors()) {
      backConfirmationModalOpen = true;
    } else {
      onBack();
    }
  }

  function handleDropdownChange(key: string, detail: { selectedId: string }) {
    selectedValues[key] = detail.selectedId;
    updateConfig();
  }

  async function handleActionClick(key: string) {
    if (!selectedAddon) return;
    const option = selectedAddon.configTemplate[key];
    if (!isActionOption(option)) return;

    const actionOption = option as ActionOption & { taskName?: string };
    const taskName = actionOption.taskName || key;
    const manifest = {
      __taskName: taskName,
      ...actionOption.manifest,
    };

    try {
      await runTask(
        {
          addonSource: selectedAddon.id,
          manifest: manifest,
          name: actionOption.displayName,
          downloadType: 'task' as const,
          taskName: taskName,
          capsuleImage: '',
          coverImage: '',
          storefront: '',
        },
        ''
      );
    } catch (error) {
      notifications.update((update) => [
        ...update,
        {
          id: Math.random().toString(36).substring(7),
          type: 'error',
          message: `Failed to run action: ${error}`,
        },
      ]);
    }
  }
</script>

{#if deleteConfirmationModalOpen}
  <DeleteAddonWarningModal
    open={deleteConfirmationModalOpen}
    onClose={() => (deleteConfirmationModalOpen = false)}
    {deleteAddonGO}
    addonName={selectedAddon?.name || ''}
  />
{/if}

{#if backConfirmationModalOpen}
  <Modal
    open={backConfirmationModalOpen}
    onClose={() => (backConfirmationModalOpen = false)}
  >
    <TitleModal title="Configuration Errors" />
    <HeaderModal header="Are you sure you want to go back?" />
    <TextModal
      text="Unsaved or invalid changes may be lost."
      variant="warning"
      class="mb-4 text-red-600"
    />
    <div class="flex flex-row items-center gap-2">
      <ButtonModal
        text="Stay"
        variant="secondary"
        onclick={() => (backConfirmationModalOpen = false)}
      />
      <ButtonModal text="Go Back" variant="danger" onclick={onBack} />
    </div>
  </Modal>
{/if}

<div class="flex flex-col justify-start items-start w-full h-full">
  <!-- Back Button -->
  <div class="flex flex-row items-center gap-1 mb-2 w-full">
    <div class="flex flex-row items-center gap-2">
      <button
        onclick={handleBackClick}
        class="flex items-center gap-3 text-accent-dark hover:bg-accent-dark/25 font-archivo py-2 px-4 rounded-lg hover:text-accent-darker transition-colors bg-transparent border-none cursor-pointer"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 36 36"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          class="w-6 h-6"
        >
          <path
            d="M25.4831 32.0663L9.37125 18.0075L25.4831 3.93375"
            stroke="currentColor"
            stroke-width="2.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="text-lg font-archivo">Back to List</span>
      </button>
    </div>
    <div class="flex flex-row items-center gap-2 ml-auto">
      <!-- Delete Addon Button -->
      {#if selectedAddon}
        <button
          onclick={deleteAddon}
          class="flex items-center gap-2 hover:bg-accent-dark/25 text-lg text-accent-dark font-archivo py-2 px-2 rounded-lg transition-colors border-none cursor-pointer"
          title="Delete this addon"
          aria-label="Delete"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
            enable-background="new 0 0 24 24"
            height="24"
            viewBox="0 0 24 24"
            width="24"
            ><g><path d="M0,0h24v24H0V0z" fill="none" /></g><g
              ><path
                d="M6,19c0,1.1,0.9,2,2,2h8c1.1,0,2-0.9,2-2V7H6V19z M9.17,12.59c-0.39-0.39-0.39-1.02,0-1.41c0.39-0.39,1.02-0.39,1.41,0 L12,12.59l1.41-1.41c0.39-0.39,1.02-0.39,1.41,0s0.39,1.02,0,1.41L13.41,14l1.41,1.41c0.39,0.39,0.39,1.02,0,1.41 s-1.02,0.39-1.41,0L12,15.41l-1.41,1.41c-0.39,0.39-1.02,0.39-1.41,0c-0.39-0.39-0.39-1.02,0-1.41L10.59,14L9.17,12.59z M18,4h-2.5 l-0.71-0.71C14.61,3.11,14.35,3,14.09,3H9.91c-0.26,0-0.52,0.11-0.7,0.29L8.5,4H6C5.45,4,5,4.45,5,5s0.45,1,1,1h12 c0.55,0,1-0.45,1-1S18.55,4,18,4z"
              /></g
            ></svg
          >
        </button>
      {/if}
    </div>
  </div>

  {#if selectedAddon}
    <!-- Addon Header -->
    <div class="addon-header">
      <div class="addon-header-content">
        <div class="addon-icon-container">
          <AddonPicture
            addonId={selectedAddon.id}
            class="rounded-lg object-cover w-[48px] h-[48px]"
          />
        </div>
        <div class="addon-info">
          <h1 class="addon-title">{selectedAddon.name}</h1>
          <p class="addon-description">{selectedAddon.description}</p>
        </div>
      </div>
    </div>

    <!-- Configuration Options -->
    {#if Object.keys(selectedAddon.configTemplate).length > 0}
      <div class="config-section">
        <div class="options">
          <div class="hidden outline-red-500 outline-4"></div>
          {#each Object.keys(selectedAddon.configTemplate) as key}
            <div
              class="flex flex-row gap-2 items-center relative"
              data-input-parent
            >
              <label
                for={key}
                onmouseover={showDescription}
                onfocus={showDescription}
                onmouseleave={hideDescription}
                class="config-label"
                >{selectedAddon.configTemplate[key].displayName}</label
              >
              {#if isStringOption(selectedAddon.configTemplate[key])}
                {@const option = selectedAddon.configTemplate[key]}
                {#if option.allowedValues.length > 0}
                  <div class="config-input-container">
                    <CustomDropdown
                      id={key}
                      options={option.allowedValues.map((v) => ({
                        id: v,
                        name: v,
                      }))}
                      selectedId={selectedValues[key]}
                      onchange={(e) => handleDropdownChange(key, e)}
                    />
                  </div>
                {:else if option.inputType === 'text' || option.inputType === 'password'}
                  <input
                    data-input
                    type={option.inputType}
                    onchange={updateConfig}
                    value={getStoredOrDefaultValue(key)}
                    id={key}
                    maxlength={option.maxTextLength}
                    minlength={option.minTextLength}
                    class="config-input"
                  />
                {:else if option.inputType === 'file' || option.inputType === 'folder'}
                  <div class="flex items-center gap-2">
                    <input
                      type="text"
                      data-input
                      onchange={updateConfig}
                      value={getStoredOrDefaultValue(key)}
                      id={key}
                      class="config-input"
                    />
                    {#if option.inputType === 'folder'}
                      <button
                        class="browse-button"
                        onclick={(ev) => browseForFolder(ev, 'folder')}
                        >Browse</button
                      >
                    {:else if option.inputType === 'file'}
                      <button
                        class="browse-button"
                        onclick={(ev) => browseForFolder(ev, 'file')}
                        >Browse</button
                      >
                    {/if}
                  </div>
                {/if}
              {/if}
              {#if isNumberOption(selectedAddon.configTemplate[key])}
                {@const option = selectedAddon.configTemplate[key]}
                <input
                  data-input
                  type={option.inputType}
                  id={key}
                  oninput={(event) =>
                    updateInputNum(event.target as HTMLInputElement)}
                  onchange={updateConfig}
                  value={getStoredOrDefaultValue(key)}
                  max={option.max}
                  min={option.min}
                  class="config-input"
                />
                {#if option.inputType === 'range'}
                  <input
                    type="number"
                    class="range-value min-w-12 text-center px-3 py-1 bg-accent-light text-accent-dark rounded-lg font-archivo font-semibold text-lg"
                    value={getStoredOrDefaultValue(key)}
                    min={option.min}
                    max={option.max}
                    onchange={updateConfig}
                    oninput={(event) => {
                      const element = document.getElementById(
                        key
                      ) as HTMLInputElement;
                      if (element && event.target instanceof HTMLInputElement) {
                        element.value = event.target.value;
                      }
                    }}
                  />
                {/if}
              {/if}
              {#if isBooleanOption(selectedAddon.configTemplate[key])}
                <label class="checkbox-container">
                  <input
                    data-input
                    type="checkbox"
                    id={key}
                    onchange={updateConfig}
                    class="input-checkbox"
                    checked={getStoredOrDefaultValue(key)}
                  />
                  <span class="checkbox-checkmark"></span>
                </label>
              {/if}
              {#if isActionOption(selectedAddon.configTemplate[key])}
                {@const option = selectedAddon.configTemplate[
                  key
                ] as ActionOption}
                <button
                  onclick={() => handleActionClick(key)}
                  class="action-button ml-auto"
                >
                  {option.buttonText || 'Run'}
                </button>
              {/if}
              <p
                data-error-message
                class="text-red-500"
                data-context=""
                onmouseenter={showContextHint}
                onmouseleave={hideContextHint}
              ></p>

              <div
                data-contextual
                style="display: none"
                class="absolute flex flex-row gap-3 justify-start items-center z-30 top-12 left-0 bg-error-bg border border-error-border text-sm p-4 rounded-lg shadow-lg w-full"
              >
                <img
                  src="./error.svg"
                  alt="error"
                  class="w-4 h-4 mt-0.5 shrink-0"
                />
                <p class="text-red-700 leading-relaxed"></p>
              </div>
              <div
                data-description
                style="display: none"
                class="absolute flex flex-row gap-3 justify-start items-center z-30 top-12 left-0 bg-info-bg border border-info-border text-sm p-4 rounded-lg shadow-lg w-full"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="w-4 h-4 mt-0.5 shrink-0 text-blue-400"
                  fill="currentColor"
                  height="24"
                  viewBox="0 0 24 24"
                  width="24"
                  ><path d="M0 0h24v24H0V0z" fill="none" /><path
                    d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 15c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1s1 .45 1 1v4c0 .55-.45 1-1 1zm1-8h-2V7h2v2z"
                  /></svg
                >
                <p class="text-blue-400 leading-relaxed relative top-[0.1rem]">
                  {selectedAddon.configTemplate[key].description}
                </p>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  @reference "../app.css";

  .addon-header {
    @apply w-full;
  }

  .addon-header-content {
    @apply flex items-center justify-start w-full rounded-lg;
    height: 80px;
    min-height: unset;
    padding: 1rem 1.25rem;
  }

  .addon-icon-container {
    @apply flex items-center justify-center;
    width: 64px;
    height: 64px;
    flex-shrink: 0;
  }

  .addon-info {
    @apply flex flex-col justify-center flex-1 ml-4;
  }

  .addon-title {
    @apply font-semibold text-gray-900 font-archivo;
    font-size: 1.25rem;
    margin-bottom: 0.25rem;
    line-height: 1.2;
  }

  .addon-description {
    @apply text-gray-600;
    font-size: 0.95rem;
    line-height: 1.4;
    margin-bottom: 0;
  }

  .config-section {
    @apply w-full mt-4 rounded-lg bg-accent-lighter;
    padding: 1rem 1.25rem;
  }

  .options {
    @apply gap-4 flex flex-col w-full rounded-lg;
  }

  .config-label {
    @apply text-lg font-medium text-gray-700 min-w-48 font-archivo;
  }

  .config-input {
    @apply px-3 py-2 bg-surface rounded-lg border border-border-muted text-base min-w-64 ml-auto;
  }

  .config-input-container {
    @apply min-w-64 ml-auto;
  }

  .checkbox-container {
    @apply relative flex items-center cursor-pointer ml-auto;
  }
  .input-checkbox {
    @apply sr-only;
  }
  .checkbox-checkmark {
    @apply w-5 h-5 bg-surface border-2 border-border-muted rounded flex items-center justify-center transition-colors;
  }
  .input-checkbox:checked + .checkbox-checkmark {
    @apply bg-accent border-accent;
  }
  .input-checkbox:not(:checked) + .checkbox-checkmark::after {
    content: '–';
    @apply text-gray-400 text-sm font-archivo;
  }
  .input-checkbox:checked + .checkbox-checkmark::after {
    content: '•';
    @apply text-white text-sm font-archivo;
  }

  .browse-button {
    @apply bg-accent-light hover:bg-accent-dark text-white px-4 py-2 rounded-lg transition-colors border-none cursor-pointer;
  }

  .action-button {
    @apply bg-accent-light hover:bg-accent-dark text-accent-dark hover:text-white px-6 py-2 rounded-lg transition-colors border-none cursor-pointer font-archivo font-semibold;
  }

  input[type='number']::-webkit-inner-spin-button,
  input[type='number']::-webkit-outer-spin-button {
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    margin: 0;
  }
</style>
