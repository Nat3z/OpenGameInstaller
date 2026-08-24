<script lang="ts">
import ButtonModal from '@/frontend/components/modal/ButtonModal.svelte';
import Modal from '@/frontend/components/modal/Modal.svelte';
import TitleModal from '@/frontend/components/modal/TitleModal.svelte';

interface Props {
  gameName: string;
  message: string;
  onAnswer: (proceed: boolean) => void;
}

let { gameName, message, onAnswer }: Props = $props();
</script>

<Modal
  open={true}
  size="small"
  closeOnOverlayClick={false}
  onClose={() => onAnswer(false)}
>
  <TitleModal title="Addon launch step failed" />
  <p class="mb-2 text-sm text-accent-dark">{message}</p>
  <p class="mb-4 text-sm text-accent-dark">Launch {gameName} anyway?</p>
  <div class="flex flex-row gap-3">
    <ButtonModal
      text="Launch Anyway"
      variant="primary"
      onclick={() => onAnswer(true)}
    />
    <ButtonModal
      text="Cancel"
      variant="secondary"
      onclick={() => onAnswer(false)}
    />
  </div>
</Modal>
