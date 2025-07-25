<script lang="ts">
  import { onMount } from 'svelte';

  let { addonId, class: className }: { addonId: string; class?: string } =
    $props();
  let image = $state<string | undefined>(undefined);

  onMount(() => {
    console.log('Getting addon icon for: ' + addonId);
    window.electronAPI.app.getAddonIcon(addonId).then(async (iconPath) => {
      if (iconPath) {
        image = await window.electronAPI.app.getLocalImage(iconPath);
      }
    });
  });
</script>

<div class={className}>
  {#if image}
    <img
      src={image}
      alt="Addon Icon"
      class="w-full h-full object-cover {className}"
    />
  {:else}
    <div
      class="w-full h-full bg-accent-light p-4 flex items-center justify-center text-accent-dark uppercase text-2xl {className}"
    >
      {addonId.slice(0, 2)}
    </div>
  {/if}
</div>
