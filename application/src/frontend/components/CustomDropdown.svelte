<script lang="ts">
  import { fly } from 'svelte/transition';

  let {
    options,
    selectedId,
    id,
    onchange,
  }: {
    options: {
      id: string;
      name: string;
      description?: string;
      icon?: string;
      iconWidth?: number;
      iconHeight?: number;
    }[];
    selectedId: string;
    id: string;
    onchange: (detail: { selectedId: string }) => void;
  } = $props();

  let showDropdown = $state(false);

  let selectedOption = $derived(
    options.find((opt) => opt.id === selectedId) || options[0]
  );

  function selectOption(optionId: string) {
    selectedId = optionId;
    showDropdown = false;
    onchange({ selectedId: optionId });
  }

  $effect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(`.custom-dropdown-button-${id}`)) {
        showDropdown = false;
      }
    }
    document.addEventListener('click', handleClickOutside);

    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  });
</script>

<div class="relative">
  <!-- Hidden select for form submission -->
  <select {id} class="hidden" bind:value={selectedId}>
    {#each options as option}
      <option value={option.id}>{option.name}</option>
    {/each}
  </select>

  <!-- Custom dropdown button -->
  <button
    type="button"
    class="custom-dropdown-button custom-dropdown-button-{id}"
    onclick={() => (showDropdown = !showDropdown)}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showDropdown = !showDropdown;
      }
    }}
  >
    {#if selectedOption}
      <div class="flex items-center gap-3">
        {#if selectedOption.icon}
          <img
            src={selectedOption.icon}
            alt={selectedOption.name}
            class="w-6 h-6 object-contain"
          />
        {/if}
        <span class="font-medium">
          {selectedOption.name}
        </span>
      </div>
    {/if}
    <svg
      class="w-5 h-5 transition-transform duration-200"
      class:rotate-180={showDropdown}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M19 9l-7 7-7-7"
      />
    </svg>
  </button>

  <!-- Custom dropdown menu -->
  {#if showDropdown}
    <div
      class="custom-dropdown-menu w-full overflow-x-hidden"
      in:fly={{ y: -10, duration: 200 }}
      out:fly={{ y: -10, duration: 150 }}
    >
      {#each options as option, index (option.id)}
        <button
          type="button"
          class="custom-dropdown-option"
          class:selected={selectedId === option.id}
          onclick={() => selectOption(option.id)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectOption(option.id);
            }
          }}
          title={option.description}
          in:fly={{
            x: -20,
            duration: 200,
            delay: index * 50,
          }}
          out:fly={{ x: -20, duration: 150 }}
        >
          <div class="flex gap-3 w-full justify-start items-start">
            {#if option.icon}
              <img
                src={option.icon}
                alt={option.name}
                width={option.iconWidth || 24}
                height={option.iconHeight || 24}
                class="object-contain"
              />
            {/if}
            <div class="font-medium text-text-primary">
              {option.name}
            </div>
          </div>
          {#if option.description}
            <div class="flex-1 text-left">
              <div class="text-sm text-text-secondary mt-1">
                {option.description}
              </div>
            </div>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  @reference "../app.css";

  .custom-dropdown-button {
    @apply w-full px-4 py-3 bg-surface border border-border rounded-lg flex items-center justify-between hover:border-accent focus:ring-2 focus:ring-accent-light focus:border-accent transition-colors text-text-primary;
  }

  .custom-dropdown-menu {
    @apply absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-10 max-h-80 overflow-y-auto;
    box-shadow:
      0 10px 25px -5px rgba(0, 0, 0, 0.1),
      0 8px 10px -6px rgba(0, 0, 0, 0.1);
  }

  .custom-dropdown-menu::-webkit-scrollbar {
    width: 8px;
    -webkit-appearance: none;
  }

  .custom-dropdown-menu::-webkit-scrollbar:horizontal {
    height: 8px;
  }

  .custom-dropdown-menu::-webkit-scrollbar-track {
    background-color: var(--color-bg-secondary);
    border-radius: 0.5rem;
    -webkit-box-shadow: inset 0 0 1px rgba(0, 0, 0, 0.1);
  }

  .custom-dropdown-menu::-webkit-scrollbar-thumb {
    background-color: var(--color-scrollbar);
    border-radius: 9999px;
    transition: background-color 0.2s ease;
    -webkit-box-shadow: inset 0 0 1px rgba(0, 0, 0, 0.2);
    min-height: 20px;
  }

  .custom-dropdown-menu::-webkit-scrollbar-thumb:hover {
    background-color: var(--color-scrollbar-hover);
  }

  .custom-dropdown-menu::-webkit-scrollbar-corner {
    background-color: var(--color-bg-secondary);
  }

  .custom-dropdown-menu {
    scrollbar-width: thin;
    scrollbar-color: var(--color-scrollbar) var(--color-bg-secondary);
    scrollbar-gutter: stable;
  }

  .custom-dropdown-option {
    @apply w-full p-4 flex flex-col items-start gap-3 hover:bg-accent-lighter transition-all duration-200 border-none text-left;
  }

  .custom-dropdown-option:first-child {
    @apply rounded-t-lg;
  }

  .custom-dropdown-option:last-child {
    @apply rounded-b-lg;
  }

  .custom-dropdown-option:hover {
    @apply bg-accent-lighter;
    transform: scale(1.02);
  }

  .custom-dropdown-option.selected {
    @apply bg-accent-light;
  }

  .custom-dropdown-option.selected:hover {
    @apply bg-accent-light;
  }
</style>
