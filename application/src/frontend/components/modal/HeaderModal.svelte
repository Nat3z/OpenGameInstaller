<script lang="ts">
  import CloseModal from './CloseModal.svelte';
  
  let { 
    header,
    class: className = "",
    onClose,
    closePosition = "top-right"
  }: { 
    header: string;
    class?: string;
    closePosition?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
    onClose?: () => void;
  } = $props();
</script>

<h2 class="font-archivo text-lg font-semibold text-accent mb-2 tracking-tight {className}">{header}</h2>

{#if onClose !== undefined}
  <CloseModal 
    position={closePosition}
    {onClose}
  />
{/if}