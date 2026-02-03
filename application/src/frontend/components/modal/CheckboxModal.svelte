<script lang="ts">
  let {
    id,
    label,
    description = '',
    checked = false,
    disabled = false,
    class: className = '',
    onchange,
  }: {
    id: string;
    label: string;
    description?: string;
    checked?: boolean;
    disabled?: boolean;
    class?: string;
    onchange?: (id: string, checked: boolean) => void;
  } = $props();

  function handleChange(event: Event) {
    const target = event.target as HTMLInputElement;
    checked = target.checked;
    onchange?.(id, checked);
  }
</script>

<div class="flex flex-col items-start justify-center relative {className}">
  <label
    class="flex flex-row gap-2 items-center relative"
    class:cursor-pointer={!disabled}
    class:cursor-not-allowed={disabled}
  >
    <input
      type="checkbox"
      {id}
      {checked}
      {disabled}
      onchange={handleChange}
      class="input-checkbox"
      data-input
    />
    <span class="checkbox-checkmark"></span>
    <span
      class="text-accent-dark font-medium select-none"
      class:text-gray-500={disabled}>{label}</span
    >
  </label>
  {#if description}
    <p class="block text-xs text-gray-500 mt-1 pl-7">{description}</p>
  {/if}
</div>

<style>
  @reference "../../app.css";

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

  .input-checkbox:disabled + .checkbox-checkmark {
    @apply bg-border border-border-muted;
  }
</style>
