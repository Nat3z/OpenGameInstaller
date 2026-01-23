<script lang="ts">
  import {
    type BooleanOption,
    type ConfigurationFile,
    type ConfigurationOption,
    type NumberOption,
    type StringOption,
    type ActionOption,
    isActionOption,
  } from 'ogi-addon/config';
  import { writable, type Writable } from 'svelte/store';

  import Modal from './Modal.svelte';
  import TitleModal from './TitleModal.svelte';
  import HeaderModal from './HeaderModal.svelte';
  import InputModal from './InputModal.svelte';
  import CheckboxModal from './CheckboxModal.svelte';
  import ButtonModal from './ButtonModal.svelte';

  // Type guard functions
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

  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }

  // State management
  let screenRendering: ConfigurationFile | undefined = $state(undefined);
  let screenID: string | undefined;
  let screenName: string | undefined = $state(undefined);
  let screenDescription: string | undefined = $state(undefined);
  let formData: { [key: string]: any } = $state({});

  let listOfScreensQueued: Writable<
    {
      config: ConfigurationFile;
      id: string;
      name: string;
      description: string;
    }[]
  > = writable([]);

  // Event listener for input requests
  document.addEventListener('input-asked', (e) => {
    if (!isCustomEvent(e)) return;
    const { detail } = e;
    const {
      config,
      id,
      name,
      description,
    }: {
      config: ConfigurationFile;
      id: string;
      name: string;
      description: string;
    } = detail;
    listOfScreensQueued.update((screens) =>
      screens.concat({ config, id, name, description })
    );
    console.log('listOfScreensQueued', $listOfScreensQueued);
  });

  // Queue subscription to process screens
  listOfScreensQueued.subscribe((screens) => {
    if (screens.length === 0) return;
    if (screenRendering) return;

    const screen = screens[0];
    screenRendering = screen.config;
    screenID = screen.id;
    screenName = screen.name;
    screenDescription = screen.description;

    // Initialize form data with default values
    formData = {};
    Object.keys(screen.config).forEach((key) => {
      const option = screen.config[key];
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

    listOfScreensQueued.update((screens) => screens.slice(1));
  });

  function handleInputChange(id: string, value: string | number | boolean) {
    formData[id] = value;
  }

  function handleSubmit() {
    window.electronAPI.app.inputSend(
      screenID!!,
      JSON.parse(JSON.stringify(formData))
    );
    console.log('Submitted data:', formData);
    closeModal();
  }

  function handleActionSubmit(key: string) {
    formData[key] = true;
    handleSubmit();
  }

  $effect(() => {
    console.log('screenRendering', screenRendering);
    console.log('isNull', screenRendering === undefined);
  });

  function closeModal() {
    screenRendering = undefined;
    screenID = undefined;
    screenName = undefined;
    screenDescription = undefined;
    formData = {};

    // Process next screen if available
    if ($listOfScreensQueued.length !== 0) {
      listOfScreensQueued.update((screens) => {
        if (screens.length === 0) return [];
        const screen = screens[0];
        screenRendering = screen.config;
        screenID = screen.id;
        screenName = screen.name;
        screenDescription = screen.description;

        // Initialize form data for next screen
        formData = {};
        Object.keys(screen.config).forEach((key) => {
          const option = screen.config[key];
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

        return screens.slice(1);
      });
    }
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

  function getInputOptions(
    option: ConfigurationOption
  ): { id: string; name: string }[] {
    if (isStringOption(option)) {
      return option.allowedValues.map((value) => ({ id: value, name: value }));
    }
    return [];
  }
</script>

{#key screenRendering}
  {#if screenRendering !== undefined}
    <Modal
      open={screenRendering !== undefined}
      priority="addon-ask"
      size="medium"
      boundsClose={false}
    >
      {#if screenRendering && screenName && screenDescription}
        <TitleModal title={screenName} />
        <HeaderModal header={screenDescription} class="mb-4" />

        <!-- Render non-action options first -->
        {#each Object.keys(screenRendering) as key}
          {#if !isActionOption(screenRendering[key])}
            {#if isBooleanOption(screenRendering[key])}
              <CheckboxModal
                id={key}
                label={screenRendering[key].displayName}
                description={screenRendering[key].description}
                checked={formData[key]}
                onchange={handleInputChange}
              />
            {:else}
              <InputModal
                id={key}
                label={screenRendering[key].displayName}
                description={screenRendering[key].description}
                type={getInputType(screenRendering[key])}
                value={getInputValue(key, screenRendering[key])}
                options={getInputOptions(screenRendering[key])}
                min={isNumberOption(screenRendering[key])
                  ? screenRendering[key].min
                  : undefined}
                max={isNumberOption(screenRendering[key])
                  ? screenRendering[key].max
                  : undefined}
                maxLength={isStringOption(screenRendering[key])
                  ? screenRendering[key].maxTextLength
                  : undefined}
                minLength={isStringOption(screenRendering[key])
                  ? screenRendering[key].minTextLength
                  : undefined}
                onchange={handleInputChange}
              />
            {/if}
          {/if}
        {/each}

        <!-- Group all action buttons together in a row -->
        {#if screenRendering && Object.keys(screenRendering).some((key) => screenRendering && isActionOption(screenRendering[key]))}
          <div class="flex flex-row gap-2 mt-4">
            {#each Object.keys(screenRendering) as key}
              {#if isActionOption(screenRendering[key])}
                {@const actionOption = screenRendering[key] as ActionOption}
                <ButtonModal
                  text={actionOption.buttonText || 'Run'}
                  variant="primary"
                  class="w-fit"
                  onclick={() => handleActionSubmit(key)}
                />
              {/if}
            {/each}
          </div>
        {/if}

        <!-- Submit button for non-action forms -->
        {#if screenRendering && Object.keys(screenRendering).some((key) => screenRendering && !isActionOption(screenRendering[key]))}
          <ButtonModal
            text="Submit"
            variant="primary"
            class="mt-4 w-fit"
            onclick={handleSubmit}
          />
        {/if}
      {/if}
    </Modal>
  {/if}
{/key}
