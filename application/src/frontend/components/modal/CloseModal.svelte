<script lang="ts">
  import { getContext } from 'svelte';

  let {
    class: className = '',
    position = 'top-right',
  }: {
    class?: string;
    position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  } = $props();

  const positionClasses = {
    'top-right': 'absolute top-2 right-2',
    'top-left': 'absolute top-2 left-2',
    'bottom-right': 'absolute bottom-2 right-2',
    'bottom-left': 'absolute bottom-2 left-2',
  };
  const closeTool = getContext<() => void>('closeModal');
  function handleClose() {
    if (closeTool) {
      closeTool();
    }
  }
</script>

<button
  class="p-2 border-none rounded-full hover:bg-accent-lighter shadow text-accent hover:text-accent-dark focus:ring-2 focus:ring-accent flex justify-center items-center transition-colors {positionClasses[
    position
  ]} {className}"
  onclick={handleClose}
  aria-label="Close modal"
>
  <svg
    fill="currentColor"
    class="w-6 h-6"
    xmlns="http://www.w3.org/2000/svg"
    height="24"
    viewBox="0 0 24 24"
    width="24"
    ><path d="M0 0h24v24H0V0z" fill="none" /><path
      d="M18.3 5.71c-.39-.39-1.02-.39-1.41 0L12 10.59 7.11 5.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41L10.59 12 5.7 16.89c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L12 13.41l4.89 4.89c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L13.41 12l4.89-4.89c.38-.38.38-1.02 0-1.4z"
    /></svg
  >
</button>
