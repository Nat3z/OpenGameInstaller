<script lang="ts">
  import Modal from '../modal/Modal.svelte';
  import TitleModal from '../modal/TitleModal.svelte';
  import HeaderModal from '../modal/HeaderModal.svelte';
  import TextModal from '../modal/TextModal.svelte';
  import ButtonModal from '../modal/ButtonModal.svelte';

  let {
    open,
    onClose,
    gameName,
    onConfirm,
  }: {
    open: boolean;
    onClose: () => void;
    gameName: string;
    onConfirm: () => void | Promise<void>;
  } = $props();
</script>

<Modal {open} {onClose}>
  <TitleModal title="Uninstall Game" />
  <HeaderModal header={`Are you sure you want to uninstall '${gameName}'?`} />
  <TextModal
    text={`This will delete all game files from disk and remove the game from your library.`}
    variant="warning"
    class="mb-4"
  />
  <TextModal
    text="This action cannot be undone."
    variant="warning"
    class="mb-4"
  />
  <div class="flex flex-row items-center gap-2">
    <ButtonModal text="Cancel" variant="secondary" onclick={onClose} />
    <ButtonModal text="Uninstall" variant="danger" onclick={onConfirm} />
  </div>
</Modal>
