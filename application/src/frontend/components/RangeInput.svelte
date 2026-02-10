<script lang="ts">
  let {
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    disabled = false,
    id,
    class: className = '',
    showValue = true,
    editableValue = false,
    dataInput = false,
    oninput,
    onchange,
  }: {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    id?: string;
    class?: string;
    showValue?: boolean;
    editableValue?: boolean;
    dataInput?: boolean;
    oninput?: (value: number) => void;
    onchange?: (value: number) => void;
  } = $props();

  function handleRangeInput(event: Event) {
    const target = event.target as HTMLInputElement;
    const v = Number(target.value);
    value = v;
    oninput?.(v);
  }

  function handleRangeChange(event: Event) {
    const target = event.target as HTMLInputElement;
    value = Number(target.value);
    onchange?.(value);
  }

  function handleValueInputChange(event: Event) {
    const target = event.target as HTMLInputElement;
    let v = Number(target.value);
    if (Number.isNaN(v)) v = value;
    v = Math.min(max, Math.max(min, v));
    target.value = String(v);
    value = v;
    onchange?.(v);
  }
</script>

<div class="range-input-wrapper flex items-center gap-4 w-full {className}">
  <input
    type="range"
    {id}
    {value}
    {min}
    {max}
    {step}
    {disabled}
    class="range-input"
    oninput={handleRangeInput}
    onchange={handleRangeChange}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    data-input={dataInput ? '' : undefined}
  />
  {#if showValue}
    {#if editableValue}
      <input
        type="number"
        class="range-value-input"
        {value}
        {min}
        {max}
        {step}
        {disabled}
        oninput={handleValueInputChange}
        onchange={handleValueInputChange}
        aria-label="Range value"
      />
    {:else}
      <span
        class="range-value-display font-mono text-sm text-text-primary"
        aria-live="polite">{value}</span
      >
    {/if}
  {/if}
</div>

<style>
  @reference "../app.css";

  .range-input-wrapper {
    @apply flex items-center gap-4;
  }

  .range-input {
    -webkit-appearance: none;
    appearance: none;
    flex: 1;
    width: 100%;
    height: 8px;
    background: var(--theme-border);
    border-radius: 4px;
    outline: none;
    transition: background 0.2s ease;
  }

  .range-input:hover {
    background: var(--theme-border-strong);
  }

  .range-input:focus {
    outline: none;
  }

  .range-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    background: var(--theme-accent);
    border-radius: 50%;
    cursor: pointer;
    transition: all 0.2s ease;
    box-shadow: 0 2px 4px var(--theme-focus-ring);
  }

  .range-input::-webkit-slider-thumb:hover {
    background: var(--theme-accent-dark);
    transform: scale(1.1);
    box-shadow: 0 3px 6px var(--theme-focus-ring);
  }

  .range-input::-webkit-slider-thumb:active {
    transform: scale(0.95);
  }

  .range-input:focus::-webkit-slider-thumb {
    box-shadow: 0 0 0 3px var(--theme-focus-ring);
  }

  .range-input::-moz-range-track {
    width: 100%;
    height: 8px;
    background: var(--theme-border);
    border-radius: 4px;
  }

  .range-input::-moz-range-thumb {
    width: 20px;
    height: 20px;
    background: var(--theme-accent);
    border-radius: 50%;
    cursor: pointer;
    border: none;
    transition: all 0.2s ease;
    box-shadow: 0 2px 4px var(--theme-focus-ring);
  }

  .range-input::-moz-range-thumb:hover {
    background: var(--theme-accent-dark);
    transform: scale(1.1);
    box-shadow: 0 3px 6px var(--theme-focus-ring);
  }

  .range-input::-moz-range-thumb:active {
    transform: scale(0.95);
  }

  .range-input:focus::-moz-range-thumb {
    box-shadow: 0 0 0 3px var(--theme-focus-ring);
  }

  .range-value-input {
    @apply min-w-12 text-center px-3 py-1.5 rounded-lg font-archivo font-semibold bg-accent-light text-accent-dark text-base border-none focus:ring-2 focus:ring-accent-light outline-none;
    -webkit-user-select: text;
    user-select: text;
    cursor: text;
  }

  .range-value-input::-webkit-inner-spin-button,
  .range-value-input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .range-value-display {
    min-width: 2.5rem;
    text-align: center;
  }
</style>
