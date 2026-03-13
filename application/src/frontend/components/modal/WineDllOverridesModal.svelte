<script lang="ts">
  import Modal from './Modal.svelte';
  import TitleModal from './TitleModal.svelte';
  import TextModal from './TextModal.svelte';
  import ButtonModal from './ButtonModal.svelte';

  type DllOverrideRow = {
    id: string;
    dll: string;
    override: string;
  };

  let {
    open = false,
    initialOverrides = [],
    onSave,
    onClose,
  }: {
    open?: boolean;
    initialOverrides?: string[];
    onSave?: (overrides: string[]) => void;
    onClose?: () => void;
  } = $props();

  let rows: DllOverrideRow[] = $state([]);

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
        equalsIndex >= 0
          ? trimmedEntry.slice(equalsIndex + 1).trim()
          : '',
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

  function handleSave() {
    onSave?.(serializeRows());
    onClose?.();
  }
</script>

{#if open}
  <Modal open={true} size="large" priority="urgent" onClose={onClose}>
    <TitleModal title="Wine DLL Overrides" />
    <TextModal
      text="Edit WINEDLLOVERRIDES entries for this game. Leave Override blank to keep Wine's default n,b fallback."
      variant="description"
      class="mb-4"
    />

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
            <label class="sr-only" for={`dll-override-${row.id}`}>Override value</label>
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
      <ButtonModal
        text="Add DLL"
        variant="secondary"
        onclick={addRow}
      />
      <p class="hint-text">
        e.g. <code>dinput8=n,b</code>, <code>winmm=b</code>, <code>xinput1_3=n</code>
      </p>
    </div>

    <div class="pt-4 flex flex-row gap-3">
      <ButtonModal
        text="Save & Close"
        variant="primary"
        onclick={handleSave}
      />
      <ButtonModal text="Cancel" variant="secondary" onclick={onClose} />
    </div>
  </Modal>
{/if}

<style>
  @reference "../../app.css";

  .dll-table {
    @apply w-full border border-border rounded-lg overflow-hidden;
  }

  .dll-table-header {
    @apply flex items-center gap-2 px-3 py-2 bg-accent-lighter text-text-secondary font-archivo text-sm font-semibold;
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
