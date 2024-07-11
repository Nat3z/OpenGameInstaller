<script lang="ts">
  import { currentDownloads } from "../store";
  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }
  function correctParsingSize(size: number) {
    if (size < 1024) {
      return size + "B";
    } else if (size < 1024 * 1024) {
      return (size / 1024).toFixed(2) + "KB";
    } else if (size < 1024 * 1024 * 1024) {
      return (size / (1024 * 1024)).toFixed(2) + "MB";
    } else {
      return (size / (1024 * 1024 * 1024)).toFixed(2) + "GB";
    }
  }

  document.addEventListener('setup:log', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    const log: string[] = event.detail.log;
    const progressEvent: number = event.detail.progress;
    const download = document.querySelector(`[data-id="${downloadID}"]`);
    if (download === null) return;
    const code = download.querySelector('code')!!;
    code.innerHTML = '';
    // make each line a new line without using innerHTML
    log.forEach((line) => {
      const textNode = document.createTextNode(line);
      code.appendChild(textNode);
      code.appendChild(document.createElement('br'));
    });
    code.scrollTop = code.scrollHeight;
    const progress = download.querySelector('progress')!!;
    progress.value = progressEvent;

  });
</script>

<div class="downloads">
  {#if $currentDownloads.length === 0}
    <div class="flex justify-center text-center flex-col items-center gap-2 w-4/6 border p-8 border-gray-800 bg-gray-200">
			<p class="text-2xl">No Downloads in Progress</p>
		</div>
  {/if}
  {#each $currentDownloads as download}
    <div data-id={download.id}>
      <img src={download.coverURL} alt="Game"/>
      <section class="flex flex-col w-full">
        <h2 class="truncate w-96">{download.name}</h2>
        {#if download.status === 'completed'}
          <p class="text-green-500 font-mono">COMPLETED</p>
          <p class="text-green-600 font-mono">Setting up with {download.addonSource}</p>
          <progress class="w-full mb-2" value="0" max="1"></progress>
          <code class="h-[9.1rem] p-4 bg-gray-400 border border-black overflow-y-auto">
          </code>
        {:else if download.status === 'error'}
          <p class="text-red-500 font-mono">ERROR</p>
        {:else if download.status === 'setup-complete'}
          <p class="text-green-500 font-mono">SETUP COMPLETE</p>
        {:else}
          <section class="flex flex-row gap-8 w-full items-center p-4">
            <section class="flex-col flex w-1/3 justify-center items-center">
              <p class="text-blue-800 font-mono text-2xl">{Math.floor(download.progress * 100)}%</p>
              <p class="font-mono text-gray-400">DOWNLOADED</p>
            </section>
            <section class="flex-col flex w-1/3 justify-center items-center">
              <p class="text-yellow-500 font-mono text-2xl">{Math.floor(download.downloadSpeed)} MB/s</p>
              <p class="font-mono text-gray-400">SPEED</p>
            </section>
            <section class="flex-col flex w-1/3 justify-center items-center">
              <p class="text-gray-700 font-mono text-2xl">{correctParsingSize(download.downloadSize)}</p>
              <p class="font-mono text-gray-400">SIZE</p>
            </section>
          </section>
        {/if}
      </section>
    </div>
  {/each}
</div>

<style>
	.downloads {
		@apply flex flex-row gap-2 w-5/6;
	}
	.downloads div {
		@apply border border-gray-800 p-2 flex flex-row gap-2 w-full bg-gray-200 h-fit ;
	}

  .downloads img {
    @apply w-[187.5px] h-[250px];
  }

  .downloads h2 {
    @apply text-2xl;
  }
  
</style>