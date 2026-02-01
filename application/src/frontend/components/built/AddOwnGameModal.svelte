<script lang="ts">
  import type { LibraryInfo } from 'ogi-addon';
  import Modal from '../modal/Modal.svelte';
  import CloseModal from '../modal/CloseModal.svelte';
  import TitleModal from '../modal/TitleModal.svelte';
  import SectionModal from '../modal/SectionModal.svelte';
  import TextModal from '../modal/TextModal.svelte';
  import ButtonModal from '../modal/ButtonModal.svelte';
  import InputModal from '../modal/InputModal.svelte';
  import { createNotification } from '../../store';
  import { getAllApps } from '../../lib/core/library';

  const PLACEHOLDER_IMAGE = './favicon.png';
  const OWN_GAME_STOREFRONT = 'local';
  const OWN_GAME_ADDON_SOURCE = 'ogi';

  let {
    open = false,
    onClose,
    onSuccess,
  }: {
    open: boolean;
    onClose: () => void;
    onSuccess?: () => void;
  } = $props();

  let name = $state('');
  let executablePath = $state('');
  let workingDir = $state('');
  let launchArguments = $state('');
  let version = $state('1.0.0');
  let isSubmitting = $state(false);

  function getCwd(): string {
    const cwd = workingDir.trim();
    if (cwd) return cwd;
    const normalized = executablePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    parts.pop();
    return parts.length ? parts.join('/') : '.';
  }

  async function getNextOwnGameAppId(): Promise<number> {
    const apps = await getAllApps();
    const ownIds = apps.map((a) => a.appID).filter((id) => id < 0);
    return ownIds.length ? Math.min(...ownIds) - 1 : -1;
  }

  function buildLibraryInfo(appID: number): LibraryInfo {
    const cwd = getCwd();
    return {
      name: name.trim(),
      version: version.trim() || '1.0.0',
      cwd,
      appID,
      launchExecutable: executablePath.trim(),
      launchArguments: launchArguments.trim() || undefined,
      capsuleImage: PLACEHOLDER_IMAGE,
      coverImage: PLACEHOLDER_IMAGE,
      titleImage: PLACEHOLDER_IMAGE,
      storefront: OWN_GAME_STOREFRONT,
      addonsource: OWN_GAME_ADDON_SOURCE,
    };
  }

  async function handleSubmit() {
    const trimmedName = name.trim();
    const trimmedExecutable = executablePath.trim();
    if (!trimmedName) {
      createNotification({
        id: crypto.randomUUID(),
        type: 'error',
        message: 'Please enter a game name.',
      });
      return;
    }
    if (!trimmedExecutable) {
      createNotification({
        id: crypto.randomUUID(),
        type: 'error',
        message: 'Please select the game executable.',
      });
      return;
    }
    isSubmitting = true;
    try {
      const appID = await getNextOwnGameAppId();
      const data = buildLibraryInfo(appID);
      const result = await window.electronAPI.app.insertApp(data);

      if (result === 'setup-success' || result === 'setup-prefix-required') {
        createNotification({
          id: crypto.randomUUID(),
          type: 'success',
          message:
            result === 'setup-prefix-required'
              ? 'Game added. Launch it once via Steam to finish setup (e.g. Proton prefix).'
              : 'Game added to your library.',
        });
        onSuccess?.();
        onClose();
      } else {
        createNotification({
          id: crypto.randomUUID(),
          type: 'error',
          message: `Could not add game: ${result}`,
        });
      }
    } catch (err) {
      createNotification({
        id: crypto.randomUUID(),
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to add game.',
      });
    } finally {
      isSubmitting = false;
    }
  }

  function handleClose() {
    if (!isSubmitting) {
      name = '';
      executablePath = '';
      workingDir = '';
      launchArguments = '';
      version = '1.0.0';
      onClose();
    }
  }
</script>

<Modal open={open} onClose={handleClose} priority="ui">
  <CloseModal />
  <TitleModal title="Add your own game" />
  <SectionModal>
    <TextModal
      text="Add a game that is already installed on your system. You will need the game's executable and optionally its working directory and launch arguments."
      variant="description"
    />
    <InputModal
      id="add-own-game-name"
      label="Game name"
      description="Display name in your library"
      type="text"
      value={name}
      onchange={(_, v) => (name = String(v))}
    />
    <InputModal
      id="add-own-game-executable"
      label="Executable"
      description="Path to the game's executable (.exe or binary)"
      type="file"
      value={executablePath}
      onchange={(_, v) => (executablePath = String(v))}
    />
    <InputModal
      id="add-own-game-cwd"
      label="Working directory (optional)"
      description="Leave empty to use the executable's folder"
      type="folder"
      value={workingDir}
      onchange={(_, v) => (workingDir = String(v))}
    />
    <InputModal
      id="add-own-game-args"
      label="Launch arguments (optional)"
      description="Extra arguments passed to the executable"
      type="text"
      value={launchArguments}
      onchange={(_, v) => (launchArguments = String(v))}
    />
    <InputModal
      id="add-own-game-version"
      label="Version (optional)"
      description="e.g. 1.0.0"
      type="text"
      value={version}
      onchange={(_, v) => (version = String(v))}
    />
  </SectionModal>
  <div class="flex flex-row items-center gap-2 mt-4">
    <ButtonModal
      text="Cancel"
      variant="secondary"
      onclick={handleClose}
      disabled={isSubmitting}
    />
    <ButtonModal
      text={isSubmitting ? 'Adding…' : 'Add game'}
      variant="primary"
      onclick={handleSubmit}
      disabled={isSubmitting}
    />
  </div>
</Modal>
