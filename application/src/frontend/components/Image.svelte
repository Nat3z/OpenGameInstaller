<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    src: string;
    alt: string;
    classifier: string;
    onerror?: (e: Event) => void;
    class?: string;
  }

  let {
    src,
    alt,
    classifier,
    onerror = () => {},
    class: className = '',
  }: Props = $props();

  let imageData: string | undefined = $state();
  let loading = $state(true);
  let error = $state<string | null>(null);

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

  onMount(async () => {
    try {
      const cachePath = './images/' + classifier + '.cached';
      if (window.electronAPI.fs.exists(cachePath)) {
        imageData = window.electronAPI.fs.read(cachePath);
        loading = false;
        return;
      }
      // Fetch as arraybuffer
      const response = await window.electronAPI.app.axios<ArrayBuffer>({
        method: 'get',
        url: src,
        responseType: 'arraybuffer',
      });
      const mimeType = getMimeTypeFromUrl(src);
      // Convert to base64
      const base64 = btoa(
        new Uint8Array(response.data).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ''
        )
      );
      imageData = `data:${mimeType};base64,${base64}`;
      // Ensure cache dir exists
      if (!window.electronAPI.fs.exists('./images')) {
        window.electronAPI.fs.mkdir('./images');
      }
      window.electronAPI.fs.write(cachePath, imageData);
      loading = false;
    } catch (e) {
      error = 'Failed to load image';
      loading = false;
    }
  });
</script>

{#if loading}
  <div class="w-full h-full flex items-center justify-center">
    <div class="loading-spinner"></div>
  </div>
{:else if error}
  <div class="w-full h-full flex items-center justify-center text-red-500">
    {error}
  </div>
{:else}
  <img src={imageData} {alt} class={className} {onerror} />
{/if}
