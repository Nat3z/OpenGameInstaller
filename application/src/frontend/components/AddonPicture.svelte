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
      class="{className} bg-accent-light flex items-center rounded-lg justify-center text-accent-dark uppercase"
      style="font-size: max(1.4vw, 1.4vh, 1.4em, 1.4rem); font-weight: 400;"
    >
      {addonId.slice(0, 2)}
    </div>
  {/if}
</div>
