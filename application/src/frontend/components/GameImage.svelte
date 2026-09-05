<script lang="ts">
interface Props {
  src?: string | null;
  alt: string;
  class?: string;
  loading?: 'eager' | 'lazy';
  fallbackTitle?: boolean;
}

let {
  src,
  alt,
  class: className = '',
  loading = 'eager',
  fallbackTitle = false,
}: Props = $props();
let failedSrc: string | null | undefined = $state();
const failed = $derived(!src || failedSrc === src);
</script>

{#if failed}
  <div class="game-image-fallback {className}" role="img" aria-label={alt}>
    <div class="fallback-logo" style="background-image: url('./favicon.png')" aria-hidden="true"></div>
    {#if fallbackTitle}
      <p class="fallback-title text-white text-base py-4 text-center font-archivo">{alt}</p>
    {/if}
  </div>
{:else}
  <img {src} {alt} {loading} class={className} onerror={(event) => (failedSrc = event.currentTarget.getAttribute('src'))} />
{/if}

<style>
  .game-image-fallback {
    position: relative;
    overflow: hidden;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent), #181818;
  }

  .fallback-logo {
    position: absolute;
    inset: 20%;
    background-position: center;
    background-size: contain;
    background-repeat: no-repeat;
    opacity: 0.5;
  }

  .fallback-title {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    margin: 0;
    padding-inline: 0.5rem;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
  }
</style>
