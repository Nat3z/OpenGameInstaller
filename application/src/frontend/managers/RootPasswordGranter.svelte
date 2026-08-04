<script lang="ts">
import { Effect } from 'effect';
import ButtonModal from '@/frontend/components/modal/ButtonModal.svelte';
import HeaderModal from '@/frontend/components/modal/HeaderModal.svelte';
import InputModal from '@/frontend/components/modal/InputModal.svelte';
import Modal from '@/frontend/components/modal/Modal.svelte';
import TitleModal from '@/frontend/components/modal/TitleModal.svelte';
import { electronRpc } from '@/frontend/lib/electron-rpc';

let openRootPasswordModal = $state(false);
document.addEventListener('app:ask-root-password', () => {
  openRootPasswordModal = true;
});
</script>

{#if openRootPasswordModal}
  <Modal open={openRootPasswordModal} priority="ui" boundsClose={false}>
    <TitleModal title="Root Password" />
    <HeaderModal
      header="We need your root password to allow for flatpak to access the proton path."
    />
    <InputModal
      id="root-password"
      label="Root Password"
      type="password"
      description="We need your root password to allow for flatpak to access the proton path."
    />
    <ButtonModal
      text="Grant Root Password"
      variant="primary"
      class="mt-4"
      onclick={() => {
        Effect.runPromise(electronRpc.app.grantRootPassword(
          (document.getElementById('root-password') as HTMLInputElement)
            ?.value ?? ''
        ));
        openRootPasswordModal = false;
      }}
    />
  </Modal>
{/if}
