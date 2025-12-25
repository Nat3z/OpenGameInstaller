<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ChangelogModal from '../components/modal/ChangelogModal.svelte';
  import type { Changelog } from '../lib/changelog/types';
  import { getChangelogByVersion } from '../lib/changelog/changelogs';

  let showChangelog = $state(false);
  let currentChangelog = $state<Changelog | undefined>(undefined);

  function handleShowChangelog(event: Event) {
    if (!(event instanceof CustomEvent)) return;

    const { version } = event.detail as { version: string };

    if (!version) {
      console.warn('app:show-changelog event received without version');
      return;
    }

    const changelog = getChangelogByVersion(version);

    if (!changelog) {
      console.warn(`No changelog found for version: ${version}`);
      return;
    }

    currentChangelog = changelog;
    showChangelog = true;
  }

  function handleClose() {
    showChangelog = false;
    currentChangelog = undefined;
  }

  onMount(() => {
    document.addEventListener('app:show-changelog', handleShowChangelog);
  });

  onDestroy(() => {
    document.removeEventListener('app:show-changelog', handleShowChangelog);
  });
</script>

{#if currentChangelog}
  <ChangelogModal
    changelog={currentChangelog}
    bind:open={showChangelog}
    onClose={handleClose}
  />
{/if}
