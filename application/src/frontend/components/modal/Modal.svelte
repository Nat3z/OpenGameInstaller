<script lang="ts">
  import { onDestroy, onMount, setContext, type Snippet } from 'svelte';
  import { modalQueue, priorityToNumber, type QueuedModal } from '../../store';

  let {
    open = false,
    class: className = '',
    size = 'medium',
    closeOnOverlayClick = true,
    children,
    onClose,
    modalId = Math.random().toString(36).substring(2, 15),
    boundsClose = true,
    priority = 'ui',
  }: {
    open?: boolean;
    class?: string;
    size?: 'small' | 'medium' | 'large' | 'full';
    closeOnOverlayClick?: boolean;
    priority?: QueuedModal['priority'];
    children: Snippet;
    onClose?: () => void;
    boundsClose?: boolean;
    modalId?: string;
  } = $props();

  const sizeClasses = {
    small: 'modal-small',
    medium: 'modal-medium',
    large: 'modal-large',
    full: 'modal-full',
  };

  function handleOverlayClick(event: MouseEvent) {
    if (
      closeOnOverlayClick &&
      event.target === event.currentTarget &&
      boundsClose
    ) {
      onClose?.();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onClose?.();
    }
  }

  let modalShouldOpenQueued = $state(false);
  let unsubscriber: (() => void) | null = null;

  setContext('closeModal', () => {
    onClose?.();
    modalQueue.update((queue) => queue.filter((modal) => modal.id !== modalId));
  });

  setContext('boundsClose', boundsClose);

  $effect(() => {
    modalQueue.update((queue) =>
      queue.map((modal) => ({ ...modal, preparedToOpen: open }))
    );
  });
  onMount(() => {
    console.log('mounted', modalId, priority);
    // subscribe to the queue
    const unsub = modalQueue.subscribe((queue) => {
      console.log('queue', queue);
      const selfIdx = queue.findIndex((modal) => modal.id === modalId);
      if (selfIdx === -1) {
        return;
      }
      if (selfIdx === 0) {
        modalShouldOpenQueued = true;
      }

      modalShouldOpenQueued = (() => {
        for (const modal of queue) {
          // if the modal is me, set the state to true
          if (modal.id === modalId) {
            console.log('rendering', modal.id);
            return true;
          }
          // if the modal has a higher priority and is before me, break
          if (
            priorityToNumber[modal.priority] >= priorityToNumber[priority] &&
            modal.preparedToOpen
          ) {
            return false;
          }
        }
        return false;
      })();
    });

    // add myself to the queue
    modalQueue.update((queue) => [
      ...queue,
      { id: modalId, priority, preparedToOpen: open },
    ]);
    unsubscriber = () => {
      unsub();
    };
  });

  onDestroy(() => {
    console.log('destroyed', modalId);
    if (unsubscriber) {
      unsubscriber();
    }
    modalQueue.update((queue) => queue.filter((modal) => modal.id !== modalId));
  });
</script>

{#if open && modalShouldOpenQueued}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="w-full h-full fixed bg-slate-900/40 backdrop-blur-sm flex top-0 left-0 justify-center items-center z-40 transition-all duration-200"
    onclick={handleOverlayClick}
    onkeydown={handleKeydown}
    tabindex="-1"
    aria-modal="true"
    role="dialog"
  >
    <article
      class="bg-background-color p-8 border border-accent-lighter shadow-xl animate-fade-in-pop-fast rounded-xl relative flex flex-col {sizeClasses[
        size
      ]} {className} focus:outline-none focus:ring-2 focus:ring-accent max-h-[90vh] overflow-y-auto"
    >
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
