<script lang="ts">
  import { currentDownloads } from "../store";

  currentDownloads.subscribe((downloads) => {
    console.log(downloads);
  });

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
</script>

<div class="downloads">
  {#each $currentDownloads as download}
    <div>
      <img src={download.coverURL} alt="Game"/>
      <section class="flex flex-col w-full">
        <h2>{download.name}</h2>
        {#if download.status === 'completed'}
          <p class="text-green-500 font-mono">COMPLETED</p>
        {:else if download.status === 'error'}
          <p class="text-red-500 font-mono">ERROR</p>
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
		@apply flex flex-row gap-2 bg-gray-200 w-5/6;
	}
	.downloads div {
		@apply border border-gray-800 p-2 flex flex-row gap-2 w-full;
	}

  .downloads img {
    @apply w-[187.5px] h-[250px];
  }

  .downloads h2 {
    @apply text-2xl;
  }
  
</style>