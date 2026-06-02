<script lang="ts">
  import TextModal from '@/frontend/components/modal/TextModal.svelte';
  import CustomDropdown from '@/frontend/components/CustomDropdown.svelte';
  import RangeInput from '@/frontend/components/RangeInput.svelte';

  let {
    id,
    label,
    description = '',
    type = 'text',
    value: displayValue = '',
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

  function resolveSelectId(
    raw: string | number | undefined,
    selectOptions: { id: string; name: string; description?: string }[]
  ): string {
    if (selectOptions.length === 0) return '';
    const id = typeof raw === 'string' ? raw : '';
    return id && selectOptions.some((opt) => opt.id === id)
      ? id
      : selectOptions[0].id;
  }

  let selectedId = $derived(
    type === 'select'
      ? resolveSelectId(displayValue, options)
      : typeof displayValue === 'string'
        ? displayValue
        : ''
  );

  function syncValueFromTarget(target: HTMLInputElement) {
    if (type === 'number' || type === 'range') {
      displayValue = Number(target.value);
    } else {
      displayValue = target.value;
    }
    onchange?.(id, displayValue);
  }

  function handleChange(event: Event) {
    syncValueFromTarget(event.target as HTMLInputElement);
  }

  function handleInput(event: Event) {
    syncValueFromTarget(event.target as HTMLInputElement);
  }

  function handleDropdownChange(detail: { selectedId: string }) {
    selectedId = detail.selectedId;
    if (onchange) {
      onchange(id, selectedId);
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
    {:else if type === 'range'}
      <RangeInput
        value={Number(displayValue) || 0}
        min={min ?? 0}
        max={max ?? 100}
        {id}
        showValue={true}
        editableValue={false}
        onchange={(v) => {
          displayValue = v;
          onchange?.(id, v);
        }}
      />
    {:else if type === 'text' || type === 'password'}
      <input
        {type}
        {id}
        value={displayValue}
        oninput={handleInput}
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
        oninput={handleInput}
        onchange={handleChange}
        {min}
        {max}
        {disabled}
        class="input-number"
        data-input
      />
    {:else if type === 'file' || type === 'folder'}
      <div class="file-input-group">
        <input
          type="text"
          {id}
          value={displayValue}
          oninput={handleInput}
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
    @apply w-full px-4 py-2 border border-border rounded-lg bg-input-bg focus:ring-2 focus:ring-accent-light focus:border-accent transition-colors;
    color: var(--theme-text-primary);
  }

  .input-text::placeholder,
  .input-number::placeholder {
    color: var(--theme-text-muted);
  }

  .file-input-group {
    @apply flex gap-2;
  }

  .file-input-group .input-text {
    @apply flex-1;
  }

  .browse-button {
    @apply px-4 py-2 bg-accent rounded-lg hover:bg-accent-dark transition-colors border-none font-archivo font-semibold text-overlay-text;
  }

  /* Remove webkit number input spinners */
  .input-number::-webkit-inner-spin-button,
  .input-number::-webkit-outer-spin-button {
    @apply appearance-none m-0;
  }
</style>
