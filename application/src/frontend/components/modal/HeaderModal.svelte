<script lang="ts">
  import { getContext } from 'svelte';
  import CloseModal from './CloseModal.svelte';

  let {
    header,
    class: className = '',
    closePosition = 'top-right',
  }: {
    header: string;
    class?: string;
    closePosition?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  } = $props();
</script>

<h2
  class="font-archivo text-lg font-semibold text-accent mb-2 tracking-tight {className}"
>
  {header}
</h2>

{#if getContext('boundsClose')}
  <CloseModal position={closePosition} />
{/if}
