<script lang="ts">
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import GameImage from './GameImage.svelte';

interface Props {
  src: string;
  alt: string;
  fallbackTitle?: boolean;
  class?: string;
}

let {
  src,
  alt,
  fallbackTitle = false,
  class: className = '',
}: Props = $props();

let imageData: string | undefined = $state();
let loading = $state(true);
let error = $state<string | null>(null);
let requestVersion = 0;

async function loadImage(currentSrc: string) {
  const version = ++requestVersion;
  loading = true;
  error = null;
  imageData = undefined;
  if (!currentSrc) {
    error = 'Missing image';
    loading = false;
    return;
  }
  try {
    const resolved = await runFrontendEffect(
      electronRpc.state.loadImage(currentSrc)
    );
    if (version !== requestVersion) return;
    imageData = resolved;
  } catch (e) {
    if (version !== requestVersion) return;
    error = 'Failed to load image';
  }
  loading = false;
}

$effect(() => {
  void loadImage(src);
});
</script>

{#if loading}
  <div class={className}>
    <div class="w-full h-full flex items-center justify-center">
      <div class="loading-spinner"></div>
    </div>
  </div>
{:else}
  <GameImage src={error ? undefined : imageData} {alt} class={className} {fallbackTitle} />
{/if}
