<script lang="ts">
import { formatError } from '@ogi-sdk/errors';
import ButtonModal from '@/frontend/components/modal/ButtonModal.svelte';
import CheckboxModal from '@/frontend/components/modal/CheckboxModal.svelte';
import Modal from '@/frontend/components/modal/Modal.svelte';
import TitleModal from '@/frontend/components/modal/TitleModal.svelte';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import { createNotification } from '@/frontend/store.svelte';
import type { FoundGame } from '@/lib/electron-rpc.js';

interface Props {
  games: FoundGame[];
  /** `skipped` are the folders the user chose not to add. */
  onClose: (skipped: string[], importedAny: boolean) => void;
}

let { games, onClose }: Props = $props();

// Tracks unchecked folders so every game defaults to being added.
let skipped: Set<string> = $state(new Set());
let selected: FoundGame[] = $derived(
  games.filter((found) => !skipped.has(found.path))
);
let busy = $state(false);

function toggle(path: string, checked: boolean) {
  const next = new Set(skipped);
  if (checked) next.delete(path);
  else next.add(path);
  skipped = next;
}

function skipAll() {
  onClose(
    games.map((found) => found.path),
    false
  );
}

async function importSelected() {
  busy = true;
  try {
    const { imported, errors } = await runFrontendEffect(
      electronRpc.app.importGamesFromDisk(selected.map((found) => found.path))
    );
    for (const error of errors) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: error,
        type: 'error',
      });
    }
    if (imported > 0) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: `Added ${imported} game${imported === 1 ? '' : 's'} to your library`,
        type: 'success',
      });
    }
    busy = false;
    onClose([...skipped], imported > 0);
  } catch (error) {
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: formatError(error) || 'Failed to add games',
      type: 'error',
    });
    busy = false;
  }
}
</script>

<Modal
  open={true}
  size="medium"
  closeOnOverlayClick={false}
  onClose={() => {
    if (!busy) skipAll();
  }}
>
  <TitleModal title="Games Found" />
  <p class="mb-4 text-sm text-accent-dark">
    {games.length === 1 ? 'This game was' : 'These games were'} installed by
    OpenGameInstaller but {games.length === 1 ? "isn't" : "aren't"} in your library.
    Add {games.length === 1 ? 'it' : 'them'} back to play without reinstalling.
  </p>
  <div class="flex flex-col gap-3 mb-6 overflow-y-auto min-h-0">
    {#each games as found (found.path)}
      <CheckboxModal
        id={`found-game-${found.game.appID}`}
        label={found.game.name}
        description={found.movedFrom
          ? `${found.path} (moved from ${found.movedFrom})`
          : found.path}
        checked={!skipped.has(found.path)}
        disabled={busy}
        class="break-all"
        onchange={(_, checked) => toggle(found.path, checked)}
      />
    {/each}
  </div>
  <div class="flex flex-row gap-3 mt-auto">
    <ButtonModal
      text={busy ? 'Adding…' : 'Add to Library'}
      variant="primary"
      disabled={busy || selected.length === 0}
      onclick={importSelected}
    />
    <ButtonModal
      text="Skip"
      variant="secondary"
      disabled={busy}
      onclick={skipAll}
    />
  </div>
</Modal>
