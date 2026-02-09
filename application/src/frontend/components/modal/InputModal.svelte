<script lang="ts">
  import TextModal from './TextModal.svelte';
  import CustomDropdown from '../CustomDropdown.svelte';

  let {
    id,
    label,
    description = '',
    type = 'text',
    value = '',
    options = [],
    min,
    max,
    maxLength,
    minLength,
    disabled = false,
    class: className = '',
    onchange,
  }: {
    id: string;
    label: string;
    description?: string;
    type?:
      | 'text'
      | 'password'
      | 'number'
      | 'range'
      | 'select'
      | 'file'
      | 'folder';
    value?: string | number;
    options?: { id: string; name: string; description?: string }[];
    min?: number;
    max?: number;
    maxLength?: number;
    minLength?: number;
    disabled?: boolean;
    class?: string;
    onchange?: (id: string, value: string | number) => void;
  } = $props();

  let displayValue = $state(value);
  let selectedId = $state(typeof value === 'string' ? value : '');

  $effect(() => {
    displayValue = value;
    // Clear dropdown selection when value is not a string (e.g. switched from select to number)
    selectedId = typeof value === 'string' ? value : '';
  });

  function handleChange(event: Event) {
    const target = event.target as HTMLInputElement;
    if (type === 'number' || type === 'range') {
      displayValue = Number(target.value);
    } else {
      displayValue = target.value;
    }
    if (onchange) {
      onchange(id, displayValue);
    }
  }

  function handleDropdownChange(detail: { selectedId: string }) {
    selectedId = detail.selectedId;
    if (onchange) {
      onchange(id, selectedId);
    }
  }

  function handleRangeInput(event: Event) {
    const target = event.target as HTMLInputElement;
    displayValue = Number(target.value);
    const paragraph = target.parentElement?.querySelector('p');
    if (paragraph) {
      paragraph.textContent = target.value;
    }
  }

  function browseForPath(browseType: 'file' | 'folder') {
    const dialog = window.electronAPI.fs.dialog;
    const properties: ('openDirectory' | 'openFile')[] =
      browseType === 'folder' ? ['openDirectory'] : ['openFile'];
    dialog.showOpenDialog({ properties }).then((result) => {
      if (result && result.length > 0) {
        const path = result[0];
        displayValue = path;
        if (onchange) {
          onchange(id, path);
        }
      }
    });
  }
</script>

<div class="w-full {className} mt-2">
  <TextModal text={label} variant="body" class="text-xl! font-bold" />
  {#if description}
    <TextModal text={description} variant="description" class="text-base!" />
  {/if}

  <div class="option-input mt-2">
    {#if type === 'select' && options.length > 0}
      <CustomDropdown
        {id}
        {options}
        {selectedId}
        onchange={handleDropdownChange}
      />
    {:else if type === 'text' || type === 'password'}
      <input
        {type}
        {id}
        value={displayValue}
        onchange={handleChange}
        maxlength={maxLength}
        minlength={minLength}
        {disabled}
        class="input-text"
        data-input
      />
    {:else if type === 'number'}
      <input
        type="number"
        {id}
        value={displayValue}
        onchange={handleChange}
        {min}
        {max}
        {disabled}
        class="input-number"
        data-input
      />
    {:else if type === 'range'}
      <div class="flex items-center gap-4">
        <input
          type="range"
          {id}
          value={displayValue}
          oninput={handleRangeInput}
          onchange={handleChange}
          {min}
          {max}
          {disabled}
          data-input
          class="w-full"
        />
        <p class="font-mono text-sm">{displayValue}</p>
      </div>
    {:else if type === 'file' || type === 'folder'}
      <div class="file-input-group">
        <input
          type="text"
          {id}
          value={displayValue}
          onchange={handleChange}
          {disabled}
          class="input-text"
          data-input
        />
        <button
          class="browse-button"
          onclick={() => browseForPath(type)}
          {disabled}
        >
          Browse
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  @reference "../../app.css";
  .option-label {
    @apply block text-lg font-archivo font-semibold text-text-primary mb-1;
  }

  .option-description {
    @apply text-sm text-text-secondary mb-4;
  }

  .option-input {
    @apply space-y-2;
  }

  .input-text,
  .input-number {
    @apply w-full px-4 py-2 border border-border rounded-lg bg-input-bg focus:ring-2 focus:ring-accent-light focus:border-accent transition-colors text-text-primary;
  }

  .file-input-group {
    @apply flex gap-2;
  }

  .file-input-group .input-text {
    @apply flex-1;
  }

  .browse-button {
    @apply px-4 py-2 bg-accent rounded-lg hover:bg-accent-dark transition-colors border-none font-archivo font-semibold;
    color: var(--theme-overlay-text);
  }

  /* Remove webkit number input spinners */
  .input-number::-webkit-inner-spin-button,
  .input-number::-webkit-outer-spin-button {
    @apply appearance-none m-0;
  }
</style>
