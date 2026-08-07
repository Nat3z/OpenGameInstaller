<script lang="ts">
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect } from 'effect';
import ButtonModal from '@/frontend/components/modal/ButtonModal.svelte';
import Modal from '@/frontend/components/modal/Modal.svelte';
import TextModal from '@/frontend/components/modal/TextModal.svelte';
import TitleModal from '@/frontend/components/modal/TitleModal.svelte';
import { runDetached } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';

const logger = createLogger(LOGGER_PREFIXES.frontend);

type DllOverrideRow = {
  id: string;
  dll: string;
  override: string;
};

let {
  open = false,
  initialOverrides = [],
  gameInfo,
  onSave,
  onClose,
}: {
  open?: boolean;
  initialOverrides?: string[];
  onSave?: (overrides: string[]) => void;
  gameInfo: LibraryInfo;
  onClose?: () => void;
} = $props();

let rows: DllOverrideRow[] = $state([]);
let scanError: string | null = $state(null);

function createRow(entry = ''): DllOverrideRow {
  const trimmedEntry = entry.trim();
  const equalsIndex = trimmedEntry.indexOf('=');

  return {
    id: Math.random().toString(36).slice(2, 11),
    dll:
      equalsIndex >= 0
        ? trimmedEntry.slice(0, equalsIndex).trim()
        : trimmedEntry,
    override:
      equalsIndex >= 0 ? trimmedEntry.slice(equalsIndex + 1).trim() : '',
  };
}

function cloneInitialOverrides() {
  rows =
    initialOverrides.length > 0
      ? initialOverrides.map((entry) => createRow(entry))
      : [createRow()];
}

$effect(() => {
  if (!open) return;
  scanError = null;
  cloneInitialOverrides();
});

function updateRow(
  id: string,
  key: keyof Pick<DllOverrideRow, 'dll' | 'override'>,
  value: string
) {
  rows = rows.map((row) => (row.id === id ? { ...row, [key]: value } : row));
}

function addRow() {
  rows = [...rows, createRow()];
}

function removeRow(id: string) {
  const nextRows = rows.filter((row) => row.id !== id);
  rows = nextRows.length > 0 ? nextRows : [createRow()];
}

function serializeRows() {
  return rows
    .map((row) => {
      const dll = row.dll.trim();
      const override = row.override.trim();

      if (!dll) return '';
      return override ? `${dll}=${override}` : dll;
    })
    .filter(Boolean);
}

function removeDllSuffix(dll: string): string {
  return dll.replace(/\.dll$/i, '');
}

function handleSave() {
  onSave?.(serializeRows());
  onClose?.();
}

function scanDlls() {
  const cwd = gameInfo.cwd?.trim();
  if (!cwd) {
    scanError = 'Cannot scan DLLs because this game has no configured path.';
    return;
  }
  scanError = null;

  void runDetached(
    Effect.gen(function* () {
      const files = yield* electronRpc.fs.getFilesInDir(cwd);
      const dlls = files.filter((file) => /\.dll$/i.test(file));

      yield* logger.info(`Found ${dlls.length} DLLs`);

      // then remove duplicates that are already in this list
      const uniqueDlls = dlls
        .filter((dll) => !rows.some((row) => row.dll === removeDllSuffix(dll)))
        .map((dll) => createRow(`${removeDllSuffix(dll)}=n,b`));
      yield* logger.info(`Found ${uniqueDlls.length} unique DLLs`);

      rows = [...rows, ...uniqueDlls];
    }),
    'Failed to scan DLLs'
  );
}
</script>

{#if open}
  <Modal open={true} size="large" priority="urgent" {onClose}>
    <TitleModal title="Wine DLL Overrides" />
    <TextModal
      text="Edit WINEDLLOVERRIDES entries for this game. Leave Override blank to keep Wine's default n,b fallback."
      variant="description"
      class="mb-4"
    />
    {#if scanError}
      <TextModal text={scanError} variant="warning" />
    {/if}

    <div class="dll-table">
      <div class="dll-table-header">
        <span class="dll-col">DLL</span>
        <span class="override-col">Override</span>
        <span class="action-col"></span>
      </div>

      {#each rows as row (row.id)}
        <div class="dll-table-row">
          <div class="dll-col">
            <label class="sr-only" for={`dll-name-${row.id}`}>DLL name</label>
            <input
              id={`dll-name-${row.id}`}
              class="input-text"
              type="text"
              value={row.dll}
              placeholder="dinput8"
              oninput={(event) =>
                updateRow(
                  row.id,
                  'dll',
                  (event.currentTarget as HTMLInputElement).value
                )}
            />
          </div>

          <div class="override-col">
            <label class="sr-only" for={`dll-override-${row.id}`}
              >Override value</label
            >
            <input
              id={`dll-override-${row.id}`}
              class="input-text"
              type="text"
              value={row.override}
              placeholder="n,b"
              oninput={(event) =>
                updateRow(
                  row.id,
                  'override',
                  (event.currentTarget as HTMLInputElement).value
                )}
            />
          </div>

          <div class="action-col">
            <button
              type="button"
              class="remove-btn"
              onclick={() => removeRow(row.id)}
              aria-label="Remove row"
            >
              &times;
            </button>
          </div>
        </div>
      {/each}
    </div>

    <div class="mt-3 flex items-center justify-between gap-3">
      <div class="flex flex-row gap-4">
        <ButtonModal text="Add DLL" variant="primary" onclick={addRow} />
        <ButtonModal text="Scan DLLs" variant="secondary" onclick={scanDlls} />
      </div>
      <p class="hint-text">
        e.g. <code>dinput8=n,b</code>, <code>winmm=b</code>,
        <code>xinput1_3=n</code>
      </p>
    </div>

    <div class="pt-4 flex flex-row gap-3">
      <ButtonModal text="Save & Close" variant="primary" onclick={handleSave} />
      <ButtonModal text="Cancel" variant="secondary" onclick={onClose} />
    </div>
  </Modal>
{/if}

<style>
  @reference "../../app.css";

  .dll-table {
    @apply w-full max-h-64 overflow-y-auto overscroll-contain border border-border rounded-lg;
  }

  .dll-table-header {
    @apply sticky top-0 z-10 flex items-center gap-2 px-3 py-2 bg-accent-lighter text-text-secondary font-archivo text-sm font-semibold;
  }

  .dll-table-row {
    @apply flex items-center gap-2 px-3 py-2 border-t border-border;
  }

  .dll-col {
    @apply flex-[1.4];
  }

  .override-col {
    @apply flex-1;
  }

  .action-col {
    @apply w-8 flex-shrink-0 flex justify-center;
  }

  .input-text {
    @apply w-full px-3 py-1.5 border border-border rounded-lg bg-input-bg focus:ring-2 focus:ring-accent-light focus:border-accent transition-colors text-sm;
    color: var(--theme-text-primary);
  }

  .input-text::placeholder {
    color: var(--theme-text-muted);
  }

  .remove-btn {
    @apply w-7 h-7 flex items-center justify-center rounded-lg border border-border bg-transparent text-text-secondary text-lg leading-none transition-colors cursor-pointer;
  }

  .remove-btn:hover {
    @apply bg-error/10 text-error border-error/30;
  }

  .hint-text {
    @apply m-0 text-sm text-text-secondary font-open-sans;
  }

  .hint-text code {
    @apply px-1 py-0.5 rounded bg-accent-lighter text-accent-dark text-xs;
  }
</style>
