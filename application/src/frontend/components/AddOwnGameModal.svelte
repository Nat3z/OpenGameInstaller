<script lang="ts">
  import type { LibraryInfo } from 'ogi-addon';
  import Modal from './modal/Modal.svelte';
  import TitleModal from './modal/TitleModal.svelte';
  import SectionModal from './modal/SectionModal.svelte';
  import InputModal from './modal/InputModal.svelte';
  import ButtonModal from './modal/ButtonModal.svelte';
  import CloseModal from './modal/CloseModal.svelte';
  import { createNotification } from '../store';

  const FALLBACK_IMAGE = './favicon.png';

  let {
    open = false,
    onClose,
    onSuccess,
  }: {
    open?: boolean;
    onClose?: () => void;
    onSuccess?: () => void;
  } = $props();

  let name = $state('');
  let executablePath = $state('');
  let cwd = $state('');
  let version = $state('1.0.0');
  let launchArgs = $state('');
  let capsuleImage = $state('');
  let coverImage = $state('');
  let errorMessage = $state('');
  let submitting = $state(false);

  /** Get directory of a path (cross-platform: supports / and \\) */
  function dirname(pathStr: string): string {
    const trim = pathStr.trim();
    if (!trim) return '';
    const lastSlash = Math.max(trim.lastIndexOf('/'), trim.lastIndexOf('\\'));
    return lastSlash > 0 ? trim.slice(0, lastSlash) : '';
  }

  function handleChange(id: string, value: string | number) {
    const s = String(value);
    if (id === 'name') name = s;
    else if (id === 'executablePath') {
      executablePath = s;
      if (!cwd.trim() && s.trim()) cwd = dirname(s);
    } else if (id === 'cwd') cwd = s;
    else if (id === 'version') version = s;
    else if (id === 'launchArgs') launchArgs = s;
    else if (id === 'capsuleImage') capsuleImage = s;
    else if (id === 'coverImage') coverImage = s;
    errorMessage = '';
  }

  function resetForm() {
    name = '';
    executablePath = '';
    cwd = '';
    version = '1.0.0';
    launchArgs = '';
    capsuleImage = '';
    coverImage = '';
    errorMessage = '';
  }

  $effect(() => {
    if (open) {
      resetForm();
    }
  });

  async function handleSubmit() {
    errorMessage = '';
    const trimmedName = name.trim();
    const trimmedExecutable = executablePath.trim();
    if (!trimmedName) {
      errorMessage = 'Please enter a game name.';
      return;
    }
    if (!trimmedExecutable) {
      errorMessage = 'Please choose an executable file.';
      return;
    }
    submitting = true;
    try {
      const appID = await window.electronAPI.app.generateCustomAppId();
      const info: LibraryInfo = {
        appID,
        name: trimmedName,
        version: version.trim() || '1.0.0',
        cwd: cwd.trim(),
        launchExecutable: trimmedExecutable,
        launchArguments: launchArgs.trim() || undefined,
        capsuleImage: capsuleImage.trim() || FALLBACK_IMAGE,
        coverImage: coverImage.trim() || FALLBACK_IMAGE,
        storefront: 'local',
        addonsource: 'ogi',
      };
      const result = await window.electronAPI.app.insertApp(info);
      if (
        result === 'setup-success' ||
        result === 'setup-redistributables-success' ||
        result === 'setup-prefix-required'
      ) {
        const prefixHint =
          result === 'setup-prefix-required'
            ? ' You may need to launch the game once from Steam to finish setup.'
            : '';
        createNotification({
          id: 'add-own-game-' + Date.now(),
          type: 'success',
          message: `"${trimmedName}" was added to your library.${prefixHint}`,
        });
        onClose?.();
        onSuccess?.();
      } else {
        errorMessage =
          result === 'setup-failed'
            ? 'Failed to add game. Please try again.'
            : 'Setup did not complete as expected.';
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to add game.';
      errorMessage = msg;
      createNotification({
        id: 'add-own-game-error-' + Date.now(),
        type: 'error',
        message: msg,
      });
    } finally {
      submitting = false;
    }
  }

  function handleClose() {
    if (!submitting) {
      resetForm();
      onClose?.();
    }
  }
</script>

{#if open}
  <Modal
    open={open}
    onClose={handleClose}
    priority="ui"
    size="large"
    boundsClose={!submitting}
  >
    <div class="relative">
      <TitleModal title="Add installed game" />
      <CloseModal position="top-right" />
    </div>
    <SectionModal>
      <InputModal
        id="name"
        label="Game name"
        description="Display name in your library."
        type="text"
        value={name}
        onchange={handleChange}
      />
      <InputModal
        id="executablePath"
        label="Executable path"
        description="The game's executable (.exe, .sh, or binary)."
        type="file"
        value={executablePath}
        onchange={handleChange}
        dialogFilters={[
          { name: 'Executables', extensions: ['exe', 'sh', 'bat', 'app'] },
          { name: 'All files', extensions: ['*'] },
        ]}
      />
      <InputModal
        id="cwd"
        label="Working directory"
        description="Leave empty to use the executable's folder."
        type="folder"
        value={cwd}
        onchange={handleChange}
      />
      <InputModal
        id="version"
        label="Version (optional)"
        type="text"
        value={version}
        onchange={handleChange}
      />
      <InputModal
        id="launchArgs"
        label="Launch arguments (optional)"
        type="text"
        value={launchArgs}
        onchange={handleChange}
      />
      <InputModal
        id="capsuleImage"
        label="Capsule image URL (optional)"
        type="text"
        value={capsuleImage}
        onchange={handleChange}
      />
      <InputModal
        id="coverImage"
        label="Cover image URL (optional)"
        type="text"
        value={coverImage}
        onchange={handleChange}
      />
    </SectionModal>
    {#if errorMessage}
      <p class="mt-2 text-red-600 text-sm font-medium">{errorMessage}</p>
    {/if}
    <div class="flex flex-row gap-2 mt-4">
      <ButtonModal
        text="Add game"
        variant="primary"
        onclick={handleSubmit}
        disabled={submitting}
      />
      <ButtonModal
        text="Cancel"
        variant="secondary"
        onclick={handleClose}
        disabled={submitting}
      />
    </div>
  </Modal>
{/if}
