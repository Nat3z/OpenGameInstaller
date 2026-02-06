<script lang="ts">
  import type { LibraryInfo } from 'ogi-addon';
  import Modal from '../modal/Modal.svelte';
  import TitleModal from '../modal/TitleModal.svelte';
  import CloseModal from '../modal/CloseModal.svelte';
  import ButtonModal from '../modal/ButtonModal.svelte';
  import InputModal from '../modal/InputModal.svelte';
  import { createNotification } from '../../store';

  let { open = $bindable(), onAdded } = $props<{
    open: boolean;
    onAdded: () => void;
  }>();

  let name = $state('');
  let version = $state('');
  let launchExecutable = $state('');
  let cwd = $state('');
  let launchArguments = $state('');
  let capsuleImage = $state('./favicon.png');
  let coverImage = $state('./favicon.png');

  async function addGame() {
    if (!name || !launchExecutable) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Name and Launch Executable are required',
        type: 'error',
      });
      return;
    }

    // Infer CWD if not provided
    let finalCwd = cwd;
    if (!finalCwd && launchExecutable) {
      const lastSlash = Math.max(
        launchExecutable.lastIndexOf('/'),
        launchExecutable.lastIndexOf('\\')
      );
      if (lastSlash !== -1) {
        finalCwd = launchExecutable.substring(0, lastSlash);
      }
    }

    const gameInfo: LibraryInfo = {
      name,
      version: version || '1.0.0',
      cwd: finalCwd,
      appID: Date.now(), // Unique ID
      launchExecutable,
      launchArguments: launchArguments || undefined,
      capsuleImage: capsuleImage || './favicon.png',
      coverImage: coverImage || './favicon.png',
      storefront: 'manual',
      addonsource: 'manual',
    };

    try {
      const result = await window.electronAPI.app.addManualGame(gameInfo);
      
      if (!result || result === 'setup-failed') {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Failed to add game',
          type: 'error',
        });
        return;
      }
      
      if (result === 'setup-redistributables-failed') {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Game added, but some redistributables failed to install',
          type: 'warning',
        });
      } else {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: 'Game added successfully',
          type: 'success',
        });
      }
      
      open = false;
      onAdded();
      
      // Reset fields
      name = '';
      version = '';
      launchExecutable = '';
      cwd = '';
      launchArguments = '';
      capsuleImage = './favicon.png';
      coverImage = './favicon.png';
    } catch (error) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'Failed to add game',
        type: 'error',
      });
    }
  }
</script>

{#if open}
  <Modal size="medium" {open} onClose={() => (open = false)}>
    <TitleModal title="Add Own Game" />
    <CloseModal />

    <div class="flex flex-col gap-4 max-h-[60vh] overflow-y-auto px-2">
      <InputModal
        id="game-name"
        label="Game Name"
        description="The name of the game as it will appear in your library."
        type="text"
        value={name}
        onchange={(_, v) => (name = v as string)}
      />

      <InputModal
        id="game-version"
        label="Version"
        description="Optional version of the game."
        type="text"
        value={version}
        onchange={(_, v) => (version = v as string)}
      />

      <InputModal
        id="launch-executable"
        label="Launch Executable"
        description="The main executable file to start the game."
        type="file"
        value={launchExecutable}
        onchange={(_, v) => (launchExecutable = v as string)}
      />

      <InputModal
        id="cwd"
        label="Working Directory"
        description="Optional. The directory where the game should be launched from. If empty, it will be inferred from the executable path."
        type="folder"
        value={cwd}
        onchange={(_, v) => (cwd = v as string)}
      />

      <InputModal
        id="launch-arguments"
        label="Launch Arguments"
        description="Optional command line arguments for the game."
        type="text"
        value={launchArguments}
        onchange={(_, v) => (launchArguments = v as string)}
      />

      <InputModal
        id="capsule-image"
        label="Capsule Image"
        description="Optional. The image used for the library card (Portrait)."
        type="file"
        value={capsuleImage}
        onchange={(_, v) => (capsuleImage = v as string)}
      />
      
      <InputModal
        id="cover-image"
        label="Cover Image"
        description="Optional. The background image used in the game page."
        type="file"
        value={coverImage}
        onchange={(_, v) => (coverImage = v as string)}
      />
    </div>

    <div class="flex flex-row gap-4 mt-8">
      <ButtonModal
        text="Cancel"
        onclick={() => (open = false)}
        variant="secondary"
      />
      <ButtonModal
        text="Add Game"
        variant="primary"
        onclick={addGame}
      />
    </div>
  </Modal>
{/if}
