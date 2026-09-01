<script lang="ts">
import type {
  ConfigurationFile,
  ConfigurationOptionWire,
  LibraryInfo,
} from '@ogi-sdk/connect';
import { Effect } from 'effect';
import {
  ConfigurationBuilder,
  isBooleanOption,
  isNumberOption,
  isStringOption,
} from 'ogi-addon/config';
import WineDllOverridesModal from '@/frontend/components/built/WineDllOverridesModal.svelte';
import ButtonModal from '@/frontend/components/modal/ButtonModal.svelte';
import CheckboxModal from '@/frontend/components/modal/CheckboxModal.svelte';
import InputModal from '@/frontend/components/modal/InputModal.svelte';
import Modal from '@/frontend/components/modal/Modal.svelte';
import TitleModal from '@/frontend/components/modal/TitleModal.svelte';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { addToSteam as addToSteamEffect } from '@/frontend/lib/core/steam';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import {
  completeRequiredReadd,
  getRequiredReadd,
} from '@/frontend/states.svelte';
import {
  createNotification,
  currentDownloads,
  gameRemovalTasks,
  gamesLaunched,
} from '@/frontend/store.svelte';

interface Props {
  exitPlayPage: () => void;
  gameInfo: LibraryInfo;
  onFinish: (data: { [key: string]: any } | undefined) => void;
}

let { exitPlayPage, gameInfo, onFinish }: Props = $props();

// umu treats this PROTONPATH placeholder as "use its bundled default Proton".
const UMU_PROTON_DEFAULT = 'umu-proton';

let platform = $state<string>('');
let showDllOverridesModal = $state(false);
let showRemoveConfirm = $state(false);
let protonOptions = $state<{ id: string; name: string }[]>([]);

// Get OS platform
$effect(() => {
  runFrontendEffect(electronRpc.app.getOS()).then((os) => {
    platform = os;
  });
});

// Installed compat tools for the per-game Proton picker. Option ids are the
// tool install paths, which umu consumes directly through PROTONPATH.
$effect(() => {
  if (!canEditDllOverrides) return;
  runFrontendEffect(
    electronRpc.app
      .getSteamCompatibilityTools()
      .pipe(
        Effect.catchAll(() =>
          Effect.succeed(
            [] as { id: string; name: string; installPath: string }[]
          )
        )
      )
  ).then((tools) => {
    const options = [
      { id: UMU_PROTON_DEFAULT, name: 'UMU Default (Proton-GE)' },
      ...tools.map((tool) => ({ id: tool.installPath, name: tool.name })),
    ];
    // Keep a stored version selectable even if its directory is gone.
    const stored = gameInfo.umu?.protonVersion;
    if (stored && !options.some((option) => option.id === stored)) {
      options.push({ id: stored, name: `${stored} (not installed)` });
    }
    protonOptions = options;
  });
});

let screenRendering: ConfigurationFile = new ConfigurationBuilder()
  .addStringOption((option) =>
    option
      .setDisplayName('Game Path')
      .setName('cwd')
      .setDescription('The path to the game executable')
      .setInputType('folder')
      .setDefaultValue(gameInfo.cwd ?? 'C:\\Program Files\\Game')
  )
  .addStringOption((option) =>
    option
      .setDisplayName('Game Executable')
      .setName('launchExecutable')
      .setDescription('The game executable path')
      .setInputType('file')
      .setDefaultValue(gameInfo.launchExecutable ?? 'game.exe')
  )
  .addStringOption((option) =>
    option
      .setDisplayName('Game Arguments')
      .setName('launchArguments')
      .setDescription('%command% replaces with the game executable.')
      .setInputType('text')
      .setDefaultValue(gameInfo.launchArguments ?? '%command%')
  )
  .build(false);

let formData: { [key: string]: any } = $state({});

// Initialize form data with default values
$effect(() => {
  Object.keys(screenRendering).forEach((key) => {
    const option = screenRendering[key];
    if (isBooleanOption(option)) {
      formData[key] = option.defaultValue ?? false;
    } else if (isNumberOption(option)) {
      formData[key] = option.defaultValue ?? option.min;
    } else if (isStringOption(option)) {
      if ((option.allowedValues?.length ?? 0) > 0) {
        formData[key] = option.defaultValue ?? option.allowedValues![0];
      } else {
        formData[key] = option.defaultValue ?? '';
      }
    }
  });

  formData.dllOverrides = [...(gameInfo.umu?.dllOverrides ?? [])];
  formData.protonVersion = gameInfo.umu?.protonVersion ?? UMU_PROTON_DEFAULT;
});

function handleInputChange(id: string, value: string | number | boolean) {
  formData[id] = value;
}

function pushChanges() {
  onFinish(formData);
}

function closeModal() {
  // The game is already removed from the library while its files delete in
  // the background; the deletion stays visible as a task in the side view.
  if (removalStarted) {
    exitPlayPage();
    return;
  }
  onFinish(undefined);
}

function openDllOverridesModal() {
  showDllOverridesModal = true;
}

function handleDllOverridesSave(dllOverrides: string[]) {
  formData.dllOverrides = dllOverrides;
}

let canEditDllOverrides = $derived(
  (platform === 'linux' || platform === 'darwin') && !!gameInfo.umu
);
// Background file deletion started by this window's removal, if any. Bound
// by task id so a stale task from an earlier removal of the same game is
// never mistaken for this one.
let removalTaskId: string | undefined = $state();
let removalStarted = $derived(removalTaskId !== undefined);
let removalTask = $derived(
  $gameRemovalTasks.find((task) => task.id === removalTaskId)
);
// Treat the moment before the first progress event lands as removing too.
let isRemoving = $derived(
  removalStarted && (!removalTask || removalTask.status === 'running')
);

// Close the play page once the background deletion we started finishes;
// the main process sends the completion/error notification.
$effect(() => {
  if (removalStarted && removalTask && removalTask.status !== 'running') {
    exitPlayPage();
  }
});
let dllOverridesCount = $derived.by(() => {
  const dllOverrides = Array.isArray(formData.dllOverrides)
    ? formData.dllOverrides
    : [];
  return dllOverrides.length;
});

async function removeFromList() {
  if ($gamesLaunched[gameInfo.appID]) {
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: 'Cannot remove a game while it is running.',
      type: 'error',
    });
    return;
  }
  const activeDownload = $currentDownloads.find(
    (download) =>
      download.appID === gameInfo.appID &&
      !['error', 'completed', 'seeding', 'setup-complete'].includes(
        download.status
      )
  );
  if (activeDownload) {
    createNotification({
      id: Math.random().toString(36).substring(7),
      message:
        'Cannot remove a game while a download or install is in progress.',
      type: 'error',
    });
    return;
  }

  showRemoveConfirm = false;
  const result = await runFrontendEffect(
    electronRpc.app.removeApp(gameInfo.appID)
  );
  if (result.status !== 'success') {
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: result.status === 'cancelled' ? result.message : result.error,
      type: result.status === 'cancelled' ? 'info' : 'error',
    });
    return;
  }

  completeRequiredReadd(gameInfo.appID);
  currentDownloads.update((downloads) =>
    downloads.filter((download) => download.appID !== gameInfo.appID)
  );

  if (result.deletionTaskId) {
    // Files are deleted lazily in the background; keep the window open to
    // show progress. Closing it leaves the deletion visible as a task.
    removalTaskId = result.deletionTaskId;
    if (result.warning) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: result.warning,
        type: 'info',
      });
    }
    return;
  }

  createNotification({
    id: Math.random().toString(36).substring(7),
    message: result.warning ?? 'Game removed from library',
    type: result.warning ? 'info' : 'success',
  });
  exitPlayPage();
}

function showInFolder() {
  if (gameInfo.cwd) {
    window.electronAPI.fs.showFileLoc(gameInfo.cwd);
  }
}

async function addToSteam(button: HTMLButtonElement) {
  const requiredReadd = getRequiredReadd(gameInfo.appID);
  await runFrontendEffect(
    addToSteamEffect({
      appID: gameInfo.appID,
      oldSteamAppId:
        requiredReadd?.steamAppId ?? gameInfo.umu?.steamShortcutReaddId,
      button,
      onSuccess: (warning) => {
        completeRequiredReadd(gameInfo.appID);
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: warning ?? 'Game added to Steam',
          type: warning ? 'warning' : 'success',
        });
      },
    })
  );
}

function getInputType(
  option: ConfigurationOptionWire
): 'text' | 'password' | 'number' | 'range' | 'select' | 'file' | 'folder' {
  if (isStringOption(option)) {
    if (option.allowedValues && option.allowedValues.length > 0)
      return 'select';
    if (option.inputType === 'file') return 'file';
    if (option.inputType === 'folder') return 'folder';
    if (option.inputType === 'password') return 'password';
    return 'text';
  }
  if (isNumberOption(option)) {
    return option.inputType === 'range' ? 'range' : 'number';
  }
  return 'text';
}

function getInputValue(key: string, option: ConfigurationOptionWire) {
  const value = formData[key];
  if (isBooleanOption(option)) return undefined; // Handled by CheckboxModal
  return value;
}

function getInputOptions(option: ConfigurationOptionWire): string[] {
  if (isStringOption(option)) {
    return option.allowedValues ?? [];
  }
  return [];
}
</script>

{#if Object.keys(formData).length > 0}
  <Modal open={true} size="large" onClose={closeModal}>
    <TitleModal title={gameInfo.name} />

    {#each Object.keys(screenRendering) as key}
      {#if isBooleanOption(screenRendering[key])}
        <CheckboxModal
          id={key}
          label={screenRendering[key].displayName}
          description={screenRendering[key].description}
          checked={formData[key]}
          class="mb-4"
          onchange={handleInputChange}
        />
      {:else}
        <InputModal
          id={key}
          label={screenRendering[key].displayName}
          description={screenRendering[key].description}
          type={getInputType(screenRendering[key])}
          value={getInputValue(key, screenRendering[key])}
          options={getInputOptions(screenRendering[key]).map((value) => ({
            id: value,
            name: value,
          }))}
          class="mb-4 {key === 'launchArguments' ? 'inline' : ''}"
          onchange={handleInputChange}
        />
        {#if key === 'launchArguments'}
          {#if platform === 'linux' || platform === 'darwin'}
            {#if canEditDllOverrides && protonOptions.length > 0}
              <InputModal
                id="protonVersion"
                label="Proton Version"
                description="The Proton build umu launches this game with."
                type="select"
                value={formData.protonVersion}
                options={protonOptions}
                class="mb-4"
                onchange={handleInputChange}
              />
            {/if}
            <ButtonModal
              text={dllOverridesCount > 0
                ? `DLL Overrides (${dllOverridesCount})`
                : 'DLL Overrides'}
              variant="secondary"
              onclick={openDllOverridesModal}
              disabled={!canEditDllOverrides}
            />
          {/if}
        {/if}
      {/if}
    {/each}

    <div class="pt-4 flex flex-row flex-wrap gap-3">
      <ButtonModal
        text="Save"
        variant="primary"
        onclick={pushChanges}
        disabled={removalStarted}
      />
      {#if platform === 'linux' || platform === 'darwin'}
        <ButtonModal
          text="Add to Steam"
          variant="secondary"
          disabled={removalStarted}
          onclick={(event) => {
            addToSteam(event.currentTarget as HTMLButtonElement);
          }}
        />
      {/if}
      <ButtonModal
        text="Show in Folder"
        variant="secondary"
        onclick={showInFolder}
        disabled={!gameInfo.cwd || removalStarted}
      />
      <ButtonModal
        text={isRemoving ? 'Removing…' : 'Remove Game'}
        variant="danger"
        disabled={removalStarted}
        onclick={() => (showRemoveConfirm = true)}
      />
      <ButtonModal text="Cancel" variant="secondary" onclick={closeModal} />
    </div>

    {#if isRemoving && removalTask}
      <div class="pt-3">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-text-secondary">
            Deleting files ({removalTask.deleted}/{removalTask.total})
          </span>
          <span class="text-xs text-text-secondary">
            {Math.floor(removalTask.progress)}%
          </span>
        </div>
        <div class="w-full bg-border rounded-full h-1.5">
          <div
            class="bg-error h-1.5 rounded-full transition-all duration-300"
            style="width: {removalTask.progress}%"
          ></div>
        </div>
      </div>
    {/if}
  </Modal>

  {#if showRemoveConfirm}
    <Modal
      open={true}
      size="small"
      closeOnOverlayClick={false}
      onClose={() => (showRemoveConfirm = false)}
    >
      <TitleModal title={`Remove ${gameInfo.name}?`} />
      <p class="mb-4 text-sm text-accent-dark">
        This removes the game from your library and permanently deletes its
        files{gameInfo.cwd ? ` in ${gameInfo.cwd}` : ''}. This cannot be
        undone.
      </p>
      <div class="flex flex-row gap-3">
        <ButtonModal
          text="Delete Game"
          variant="danger"
          onclick={removeFromList}
        />
        <ButtonModal
          text="Cancel"
          variant="secondary"
          onclick={() => (showRemoveConfirm = false)}
        />
      </div>
    </Modal>
  {/if}

  <WineDllOverridesModal
    open={showDllOverridesModal}
    initialOverrides={formData.dllOverrides ?? []}
    onSave={handleDllOverridesSave}
    gameInfo={gameInfo}
    onClose={() => (showDllOverridesModal = false)}
  />
{/if}
