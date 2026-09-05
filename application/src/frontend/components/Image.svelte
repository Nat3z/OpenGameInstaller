<script lang="ts">
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import GameImage from './GameImage.svelte';

interface Props {
  src: string;
  alt: string;
  classifier: string;
  fallbackTitle?: boolean;
  class?: string;
}

let {
  src,
  alt,
  classifier,
  fallbackTitle = false,
  class: className = '',
}: Props = $props();

let imageData: string | undefined = $state();
let loading = $state(true);
let error = $state<string | null>(null);
let requestVersion = 0;

function getMimeTypeFromUrl(url: string): string {
  const ext = url.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
}

async function loadImage(currentSrc: string, currentClassifier: string) {
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
    const cachePath = './images/' + currentClassifier + '.cached';
    if (window.electronAPI.fs.exists(cachePath)) {
      const cachedImage = window.electronAPI.fs.read(cachePath);
      if (version !== requestVersion) return;
      imageData = cachedImage;
      loading = false;
      return;
    }

    // Fetch as arraybuffer
    const response = await runFrontendEffect(
      electronRpc.app.axios<ArrayBuffer>({
        method: 'get',
        url: currentSrc,
        responseType: 'arraybuffer',
      })
    );
    const mimeType = getMimeTypeFromUrl(currentSrc);
    // Convert to base64
    const base64 = btoa(
      new Uint8Array(response.data).reduce(
        (data, byte) => data + String.fromCharCode(byte),
        ''
      )
    );
    const resolvedImageData = `data:${mimeType};base64,${base64}`;
    if (version !== requestVersion) return;
    imageData = resolvedImageData;
    // Ensure cache dir exists
    try {
      if (!window.electronAPI.fs.exists('./images')) {
        window.electronAPI.fs.mkdir('./images');
      }
      window.electronAPI.fs.write(cachePath, resolvedImageData);
    } catch {
      // A read-only cache must not hide an image that loaded successfully.
    }
    loading = false;
  } catch (e) {
    if (version !== requestVersion) return;
    error = 'Failed to load image';
    loading = false;
  }
}

$effect(() => {
  void loadImage(src, classifier);
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
