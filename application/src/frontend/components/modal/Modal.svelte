<script lang="ts">
  import { type Snippet } from 'svelte';

  let { 
    open = false, 
    class: className = "",
    size = "medium",
    closeOnOverlayClick = true,
    children,
    onClose
  }: { 
    open?: boolean;
    class?: string;
    size?: "small" | "medium" | "large" | "full";
    closeOnOverlayClick?: boolean;
    children: Snippet;
    onClose?: () => void;
  } = $props();

  const sizeClasses = {
    small: "modal-small",
    medium: "modal-medium", 
    large: "modal-large",
    full: "modal-full"
  };

  function handleOverlayClick(event: MouseEvent) {
    if (closeOnOverlayClick && event.target === event.currentTarget) {
      onClose?.();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onClose?.();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div 
    class="w-full h-full fixed bg-slate-900/40 backdrop-blur-sm flex top-0 left-0 justify-center items-center z-40 transition-all duration-200"
    onclick={handleOverlayClick}
    onkeydown={handleKeydown}
    tabindex="-1"
    aria-modal="true"
    role="dialog"
  >
    <article class="bg-background-color p-8 border border-accent-lighter shadow-xl animate-fade-in-pop-fast rounded-xl relative flex flex-col {sizeClasses[size]} {className} focus:outline-none focus:ring-2 focus:ring-accent max-h-[90vh] overflow-y-auto">
      {@render children()}
    </article>
  </div>
{/if} 

<style global>
  .modal-small {
    @apply max-w-xs w-full max-h-80;
  }
  .modal-medium {
    @apply max-w-lg w-full max-h-[32rem];
  }
  .modal-large {
    @apply max-w-2xl w-full max-h-[90vh];
  }
  .modal-full {
    @apply w-full h-full max-w-full max-h-full;
  }
</style>