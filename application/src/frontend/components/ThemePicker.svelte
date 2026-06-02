<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';

  const MENU_MAX_HEIGHT_PX = 260;

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  type ThemeOption = {
    id: string;
    name: string;
    palette: string[];
  };

  let {
    id = 'theme',
    selectedId = 'light',
    onchange,
  }: {
    id?: string;
    selectedId: string;
    onchange: (detail: { selectedId: string }) => void;
  } = $props();

  const paletteVariables = [
    '--theme-bg-primary',
    '--theme-bg-secondary',
    '--theme-accent',
    '--theme-accent-light',
  ];

  const fallbackThemes: ThemeOption[] = [
    { id: 'light', name: 'Light', palette: [] },
    { id: 'dark', name: 'Dark', palette: [] },
    { id: 'synthwave', name: 'Synthwave', palette: [] },
  ];

  let themes: ThemeOption[] = $state(fallbackThemes);

  let open = $state(false);
  let buttonEl: HTMLButtonElement | undefined = $state();
  let menuStyle = $state('');
  let internalSelectedId = $state(selectedId);

  let selectedTheme = $derived(
    themes.find((theme) => theme.id === internalSelectedId) ?? themes[0]
  );

  function toTitleCase(value: string) {
    return value
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function extractThemeIdsFromCss() {
    const themeIds = new Set<string>();

    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }

      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        const matches = rule.selectorText.matchAll(
          /\[data-theme=(?:'|")?([^'"\]]+)(?:'|")?\]/g
        );
        for (const match of matches) {
          themeIds.add(match[1]);
        }
      }
    }

    return Array.from(themeIds);
  }

  function getThemePalette(themeId: string) {
    const probe = document.createElement('div');
    probe.setAttribute('data-theme', themeId);
    probe.className = 'absolute invisible pointer-events-none';
    document.body.appendChild(probe);
    const styles = getComputedStyle(probe);
    const palette = paletteVariables
      .map((variable) => styles.getPropertyValue(variable).trim())
      .filter(Boolean);
    probe.remove();
    return palette;
  }

  function loadThemesFromCss() {
    const themeIds = extractThemeIdsFromCss();
    if (themeIds.length === 0) return;

    themes = themeIds.map((themeId) => ({
      id: themeId,
      name: toTitleCase(themeId),
      palette: getThemePalette(themeId),
    }));
  }

  function updateMenuPosition() {
    if (!buttonEl) return;
    const rect = buttonEl.getBoundingClientRect();
    const gap = 6;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUpward = spaceBelow < MENU_MAX_HEIGHT_PX && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      MENU_MAX_HEIGHT_PX,
      Math.max(0, openUpward ? spaceAbove : spaceBelow)
    );

    menuStyle = openUpward
      ? `left:${rect.left}px;width:${rect.width}px;bottom:${window.innerHeight - rect.top + gap}px;max-height:${maxHeight}px;`
      : `left:${rect.left}px;width:${rect.width}px;top:${rect.bottom + gap}px;max-height:${maxHeight}px;`;
  }

  function toggle() {
    open = !open;
    if (open) updateMenuPosition();
  }

  function selectTheme(themeId: string) {
    internalSelectedId = themeId;
    open = false;
    onchange({ selectedId: themeId });
  }

  onMount(loadThemesFromCss);

  $effect(() => {
    internalSelectedId = selectedId;
  });

  $effect(() => {
    if (!open) return;
    updateMenuPosition();
    const onScrollOrResize = () => updateMenuPosition();
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  });
</script>

<div class="theme-picker">
  <input {id} type="hidden" value={internalSelectedId} />
  <button
    bind:this={buttonEl}
    type="button"
    class="theme-picker-trigger"
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={toggle}
  >
    <span class="theme-chip-content">
      <span class="theme-palette" aria-hidden="true">
        {#each selectedTheme.palette as color}
          <span class="theme-color-dot" style={`background: ${color}`}></span>
        {/each}
      </span>
      <span>{selectedTheme.name}</span>
    </span>
    <svg
      class:open
      class="theme-picker-chevron"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fill-rule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clip-rule="evenodd"
      />
    </svg>
  </button>

  {#if open}
    <div
      use:portal
      class="theme-picker-menu"
      style={menuStyle}
      role="listbox"
      in:fly={{ y: -8, duration: 140 }}
    >
      {#each themes as theme}
        <button
          type="button"
          class="theme-option-chip"
          class:selected-theme={theme.id === internalSelectedId}
          role="option"
          aria-selected={theme.id === internalSelectedId}
          onclick={() => selectTheme(theme.id)}
        >
          <span class="theme-selection-ring" aria-hidden="true"></span>
          <span class="theme-palette" aria-hidden="true">
            {#each theme.palette as color}
              <span class="theme-color-dot" style={`background: ${color}`}></span>
            {/each}
          </span>
          <span>{theme.name}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  @reference "../app.css";

  .theme-picker {
    @apply relative w-full;
  }

  .theme-picker-trigger {
    @apply w-full px-4 py-3 border border-border rounded-lg bg-input-bg text-text-primary flex items-center justify-between gap-3 transition-colors hover:border-accent focus:ring-2 focus:ring-accent-light focus:border-accent;
  }

  .theme-chip-content,
  .theme-option-chip {
    @apply flex items-center gap-3 font-archivo font-semibold;
  }

  .theme-picker-chevron {
    @apply w-5 h-5 text-text-secondary transition-transform duration-200;
  }

  .theme-picker-chevron.open {
    @apply rotate-180;
  }

  .theme-picker-menu {
    @apply fixed z-50 p-3 overflow-y-auto rounded-xl border border-border bg-surface shadow-xl flex flex-wrap gap-2;
    box-shadow: 0 16px 40px color-mix(in srgb, var(--theme-overlay-bg) 24%, transparent);
  }

  .theme-option-chip {
    @apply px-3 py-2 rounded-full border border-border bg-input-bg text-text-primary hover:bg-accent-lighter hover:border-accent transition-colors;
  }

  .theme-option-chip.selected-theme {
    @apply border-accent bg-accent-lighter;
  }

  .theme-selection-ring {
    @apply w-3 h-3 rounded-full border border-border bg-transparent transition-colors shrink-0;
  }

  .theme-option-chip.selected-theme .theme-selection-ring {
    @apply border-accent bg-accent;
  }

  .theme-palette {
    @apply flex items-center -space-x-1;
  }

  .theme-color-dot {
    @apply block w-5 h-5 rounded-full border border-border-strong;
  }
</style>
