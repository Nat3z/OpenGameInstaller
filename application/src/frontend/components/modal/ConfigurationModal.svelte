<script lang="ts">
  import type { ConfigurationFile, ConfigurationOptionWire } from '@ogi-sdk/connect';
  import {
    isActionOption,
    isBooleanOption,
    isNumberOption,
    isStringOption,
  } from 'ogi-addon/config';
  import { get, writable, type Writable } from 'svelte/store';

  import Modal from '@/frontend/components/modal/Modal.svelte';
  import TitleModal from '@/frontend/components/modal/TitleModal.svelte';
  import HeaderModal from '@/frontend/components/modal/HeaderModal.svelte';
  import InputModal from '@/frontend/components/modal/InputModal.svelte';
  import CheckboxModal from '@/frontend/components/modal/CheckboxModal.svelte';
  import ButtonModal from '@/frontend/components/modal/ButtonModal.svelte';

  type PendingInputScreen = {
    config: ConfigurationFile;
    id: string;
    name: string;
    description: string;
    reply?: (
      result: Record<string, string | number | boolean>
    ) => void | Promise<void>;
  };

  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }

  let activeScreen: PendingInputScreen | undefined = $state(undefined);
  let formData: Record<string, string | number | boolean> = $state({});
  let submitError: string | undefined = $state(undefined);
  let isSubmitting = $state(false);

  const listOfScreensQueued: Writable<PendingInputScreen[]> = writable([]);

  function buildInitialFormData(config: ConfigurationFile) {
    const data: Record<string, string | number | boolean> = {};
    Object.keys(config).forEach((key) => {
      const option = config[key];
      if (isBooleanOption(option)) {
        data[key] = option.defaultValue ?? false;
      } else if (isNumberOption(option)) {
        data[key] = option.defaultValue ?? option.min ?? 0;
      } else if (isStringOption(option)) {
        if ((option.allowedValues?.length ?? 0) > 0) {
          const allowed = option.allowedValues!;
          const defaultValue = option.defaultValue;
          data[key] =
            defaultValue && allowed.includes(defaultValue)
              ? defaultValue
              : allowed[0];
        } else {
          data[key] = option.defaultValue ?? '';
        }
      }
    });
    return data;
  }

  function showScreen(screen: PendingInputScreen) {
    activeScreen = screen;
    formData = buildInitialFormData(screen.config);
    submitError = undefined;
    isSubmitting = false;
  }

  function processQueue() {
    if (activeScreen) return;
    const screens = get(listOfScreensQueued);
    if (screens.length === 0) return;
    showScreen(screens[0]);
    listOfScreensQueued.set(screens.slice(1));
  }

  document.addEventListener('input-asked', (e) => {
    if (!isCustomEvent(e)) return;
    const { detail } = e;
    const {
      config,
      id,
      name,
      description,
      reply,
    }: PendingInputScreen = detail;
    listOfScreensQueued.update((screens) =>
      screens.concat({ config, id, name, description, reply })
    );
    processQueue();
  });

  listOfScreensQueued.subscribe(() => {
    processQueue();
  });

  function handleInputChange(id: string, value: string | number | boolean) {
    formData = { ...formData, [id]: value };
  }

  function collectFormData(): Record<string, string | number | boolean> {
    const data = { ...formData };
    if (!activeScreen) return data;

    for (const key of Object.keys(activeScreen.config)) {
      const option = activeScreen.config[key];
      const el = document.getElementById(key) as HTMLInputElement | null;
      if (!el) continue;

      if (isNumberOption(option)) {
        const parsed = Number(el.value);
        if (!Number.isNaN(parsed)) {
          data[key] = parsed;
        }
      } else if (
        isStringOption(option) &&
        (option.allowedValues?.length ?? 0) > 0
      ) {
        const allowed = option.allowedValues!;
        const selectValue =
          (el as HTMLSelectElement).value || String(data[key] ?? '');
        data[key] =
          selectValue && allowed.includes(selectValue)
            ? selectValue
            : allowed[0];
      } else if (
        isStringOption(option) &&
        option.inputType !== 'file' &&
        option.inputType !== 'folder'
      ) {
        data[key] = el.value;
      }
    }

    return data;
  }

  async function handleSubmit(actionKey?: string) {
    if (isSubmitting || !activeScreen) return;

    const data = collectFormData();
    if (actionKey) {
      data[actionKey] = true;
    }

    isSubmitting = true;
    submitError = undefined;

    try {
      if (activeScreen.reply) {
        await activeScreen.reply(data);
      } else {
        await window.electronAPI.app.inputSend(activeScreen.id, data);
      }
      closeModal();
    } catch (error) {
      console.error('Failed to submit configuration:', error);
      submitError = error instanceof Error ? error.message : String(error);
    } finally {
      isSubmitting = false;
    }
  }

  function handleActionSubmit(key: string) {
    void handleSubmit(key);
  }

  function closeModal() {
    activeScreen = undefined;
    formData = {};
    submitError = undefined;
    isSubmitting = false;
    processQueue();
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

  function getInputValue(
    key: string,
    option: ConfigurationOptionWire
  ): string | number | undefined {
    const value = formData[key];
    if (isBooleanOption(option) || typeof value === 'boolean') {
      return undefined;
    }
    return value;
  }

  function getInputOptions(
    option: ConfigurationOptionWire
  ): { id: string; name: string }[] {
    if (isStringOption(option)) {
      return (option.allowedValues ?? []).map((value) => ({
        id: value,
        name: value,
      }));
    }
    return [];
  }
</script>

{#key activeScreen?.id}
  {#if activeScreen}
    {@const screen = activeScreen}
    <Modal
      open={true}
      priority="addon-ask"
      size="medium"
      boundsClose={false}
    >
      <TitleModal title={screen.name} />
      <HeaderModal header={screen.description} class="mb-4" />

      {#each Object.keys(screen.config) as key}
        {#if !isActionOption(screen.config[key])}
          {#if isBooleanOption(screen.config[key])}
            <CheckboxModal
              id={key}
              label={screen.config[key].displayName}
              description={screen.config[key].description}
              checked={Boolean(formData[key])}
              disabled={isSubmitting}
              onchange={handleInputChange}
            />
          {:else}
            <InputModal
              id={key}
              label={screen.config[key].displayName}
              description={screen.config[key].description}
              type={getInputType(screen.config[key])}
              value={getInputValue(key, screen.config[key])}
              options={getInputOptions(screen.config[key])}
              min={isNumberOption(screen.config[key])
                ? screen.config[key].min
                : undefined}
              max={isNumberOption(screen.config[key])
                ? screen.config[key].max
                : undefined}
              maxLength={isStringOption(screen.config[key])
                ? screen.config[key].maxTextLength
                : undefined}
              minLength={isStringOption(screen.config[key])
                ? screen.config[key].minTextLength
                : undefined}
              disabled={isSubmitting}
              onchange={handleInputChange}
            />
          {/if}
        {/if}
      {/each}

      {#if submitError}
        <p class="text-red-500 mt-2">{submitError}</p>
      {/if}

      <div class="flex flex-row gap-2 mt-4">
        {#if Object.keys(screen.config).length === 0 || Object.keys(screen.config).some((key) => !isActionOption(screen.config[key]))}
          <ButtonModal
            text={Object.keys(screen.config).length === 0
              ? 'Close'
              : 'Submit'}
            variant="primary"
            class="w-fit"
            disabled={isSubmitting}
            onclick={() => void handleSubmit()}
          />
        {/if}
        {#each Object.keys(screen.config) as key}
          {#if isActionOption(screen.config[key])}
            {@const actionOption = screen.config[key]}
            <ButtonModal
              text={actionOption.buttonText || 'Run'}
              variant="secondary"
              class="w-fit"
              disabled={isSubmitting}
              onclick={() => handleActionSubmit(key)}
            />
          {/if}
        {/each}
      </div>
    </Modal>
  {/if}
{/key}
