<script lang="ts">
import type { LibraryInfo } from '@ogi-sdk/connect';
import { formatError } from '@ogi-sdk/errors';
import ButtonModal from '@/frontend/components/modal/ButtonModal.svelte';
import CheckboxModal from '@/frontend/components/modal/CheckboxModal.svelte';
import Modal from '@/frontend/components/modal/Modal.svelte';
import TitleModal from '@/frontend/components/modal/TitleModal.svelte';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import { completeRequiredReadd } from '@/frontend/states.svelte';
import {
  createNotification,
  currentDownloads,
  hasActiveDownload,
} from '@/frontend/store.svelte';

interface Props {
  games: LibraryInfo[];
  /** `kept` are the games the user chose to keep in the library. */
  onClose: (kept: number[], removedAny: boolean) => void;
}

let { games, onClose }: Props = $props();

// Tracks unchecked games so every game, including ones added on a library
// reload, defaults to being removed.
let kept: Set<number> = $state(new Set());
let selected: LibraryInfo[] = $derived(
  games.filter((game) => !kept.has(game.appID))
);
let busy = $state(false);

function toggle(appID: number, checked: boolean) {
  const next = new Set(kept);
  if (checked) next.delete(appID);
  else next.add(appID);
  kept = next;
}

function keepAll() {
  onClose(
    games.map((game) => game.appID),
    false
  );
}

// Removes sequentially since each removal may ask to confirm Steam shortcut
// cleanup. onlyIfMissing makes the main process skip any game whose folder
// came back (e.g. a drive reconnected) and never delete files. Failed removals
// aren't reported as kept, so they're offered again on the next check.
async function removeSelected() {
  busy = true;
  let removed = 0;
  for (const game of selected) {
    // An install in progress recreates the folder; removing now would orphan it.
    if (hasActiveDownload(game.appID)) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: `${game.name}: Cannot remove a game while a download or install is in progress.`,
        type: 'error',
      });
      continue;
    }
    try {
      const result = await runFrontendEffect(
        electronRpc.app.removeApp(game.appID, true)
      );
      if (result.status !== 'success') {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: `${game.name}: ${
            result.status === 'cancelled' ? result.message : result.error
          }`,
          type: result.status === 'cancelled' ? 'info' : 'error',
        });
        continue;
      }
      if (result.warning) {
        createNotification({
          id: Math.random().toString(36).substring(7),
          message: `${game.name}: ${result.warning}`,
          type: 'info',
        });
      }
      completeRequiredReadd(game.appID);
      currentDownloads.update((downloads) =>
        downloads.filter((download) => download.appID !== game.appID)
      );
      removed++;
    } catch (error) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: `${game.name}: ${formatError(error) || 'Failed to remove game'}`,
        type: 'error',
      });
    }
  }
  if (removed > 0) {
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: `Removed ${removed} missing game${removed === 1 ? '' : 's'} from your library`,
      type: 'success',
    });
  }
  busy = false;
  onClose([...kept], removed > 0);
}
</script>

<Modal
  open={true}
  size="medium"
  closeOnOverlayClick={false}
  onClose={() => {
    if (!busy) keepAll();
  }}
>
  <TitleModal title="Missing Game Files" />
  <p class="mb-4 text-sm text-accent-dark">
    {games.length === 1 ? "This game's" : "These games'"} install folder could
    not be found. If it was deleted or lives on a disconnected drive, you can remove
    {games.length === 1 ? 'it' : 'them'} from your library.
  </p>
  <div class="flex flex-col gap-3 mb-6 overflow-y-auto min-h-0">
    {#each games as game (game.appID)}
      <CheckboxModal
        id={`missing-game-${game.appID}`}
        label={game.name}
        description={game.cwd}
        checked={!kept.has(game.appID)}
        disabled={busy}
        class="break-all"
        onchange={(_, checked) => toggle(game.appID, checked)}
      />
    {/each}
  </div>
  <div class="flex flex-row gap-3 mt-auto">
    <ButtonModal
      text={busy ? 'Removing…' : 'Remove from Library'}
      variant="danger"
      disabled={busy || selected.length === 0}
      onclick={removeSelected}
    />
    <ButtonModal
      text="Keep"
      variant="secondary"
      disabled={busy}
      onclick={keepAll}
    />
  </div>
</Modal>
