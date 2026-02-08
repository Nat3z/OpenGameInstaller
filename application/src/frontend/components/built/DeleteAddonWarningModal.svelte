<script lang="ts">
  import Modal from '../modal/Modal.svelte';
  import TitleModal from '../modal/TitleModal.svelte';
  import HeaderModal from '../modal/HeaderModal.svelte';
  import TextModal from '../modal/TextModal.svelte';
  import ButtonModal from '../modal/ButtonModal.svelte';

  let {
    open,
    onClose,
    deleteAddonGO,
    addonName,
  }: {
    open: boolean;
    onClose: () => void;
    deleteAddonGO: () => void;
    addonName: string;
  } = $props();
</script>

<Modal {open} {onClose}>
  <TitleModal title="Delete Addon" />
  <HeaderModal header={`Are you sure you want to delete '${addonName}'?`} />
  <TextModal
    text={`This will delete the addon '${addonName}' and all of its configurations.`}
    variant="warning"
    class="mb-4 text-error-text"
  />
  <TextModal
    text="This action cannot be undone."
    variant="warning"
    class="mb-4 text-error-text"
  />
  <div class="flex flex-row items-center gap-2">
    <ButtonModal text="Cancel" variant="secondary" onclick={onClose} />
    <ButtonModal text="Delete" variant="danger" onclick={deleteAddonGO} />
  </div>
</Modal>
