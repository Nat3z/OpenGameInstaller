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
  });

  document.addEventListener('setup:progress', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    const progress = event.detail.progress;
    const download = document.querySelector(`[data-id="${downloadID}"]`);
    if (download === null) return;
    const progressBar = download.querySelector('progress')!!;
    progressBar.value = progress;
  });

  // taken from: https://stackoverflow.com/questions/14783869/convert-a-decimal-number-to-a-fraction-rational-number
  var toFraction = function (dec: number) {
    var is_neg = dec < 0;
    dec = Math.abs(dec);
    var done = false;
    //you can adjust the epsilon to a larger number if you don't need very high precision
    var n1 = 0, d1 = 1, n2 = 1, d2 = 0, n = 0, q = dec, num = 0, den = 0, epsilon = 1e-13;
    while (!done) {
      n++;
      if (n > 10000) {
          done = true;
      }
      var a = q;
      num = n1 + a * n2;
      den = d1 + a * d2;
      var e = (q - a);
      if (e < epsilon) {
        done = true;
      }
      q = 1 / e;
      n1 = n2;
      d1 = d2;
      n2 = num;
      d2 = den;
      if (Math.abs(num / den - dec) < epsilon || n > 30) {
          done = true;
      }
    }
    return [is_neg ? -num : num, den];
  };
  function toRatio(x: number) {
    const fraction = toFraction(x);
    return (fraction[0] < 1 ? fraction[0].toFixed(2) : fraction[0]) + ":" + (fraction[1] < 1 ? fraction[1].toFixed(2) : fraction[1]);
  }

</script>

<div class="downloads mt-4">
  {#if $currentDownloads.length === 0}
    <div class="flex justify-center text-center flex-col items-center gap-2 w-4/6 border p-8 border-gray-800 bg-gray-200">
			<p class="text-2xl">No Downloads in Progress</p>
		</div>
  {/if}
  {#each $currentDownloads as download}
    <div data-id={download.id} class="relative">
      <img src={download.coverURL} alt="Game" style="absolute w-1/4 h-1/4"/>
      <section class="flex flex-col w-full justify-start">
        <!-- <h2 class="truncate w-96 text-lg">{download.name}</h2> -->

        {#if download.status === 'seeding' && download.ratio !== undefined}
          <h1 class="text-blue-400 font-mono">Seeding</h1>
          <section class="flex flex-row gap-8 w-full items-center justify-center p-4">
            <section class="flex-col flex w-1/3 justify-center items-center">
              <p class="text-blue-800 font-mono text-2xl">{toRatio(download.ratio)}</p>
              <p class="font-mono text-gray-400">RATIO</p>
            </section>
            <section class="flex-col flex w-1/3 justify-center items-center">
              <p class="text-yellow-500 font-mono text-2xl">{correctParsingSize(Math.floor(download.downloadSpeed))}/s</p>
              <p class="font-mono text-gray-400">SPEED</p>
            </section>
            <section class="flex-col flex w-1/3 justify-center items-center">
              <p class="text-gray-700 font-mono text-2xl">{correctParsingSize(download.downloadSize)}</p>
              <p class="font-mono text-gray-400">SIZE</p>
            </section>
          </section>
        {/if}
        {#if download.status === 'completed'}
          <p class="text-green-600 font-mono">Setting up with {download.addonSource}</p>
          <progress class="mb-2 rounded" value="0" max="100"></progress>
          <code class="h-[8.4rem] p-4 bg-slate-200 rounded overflow-y-auto w-[26rem] overflow-x-auto">
          </code>
        {:else if download.status === 'error'}
          <p class="text-red-500 font-mono">ERROR</p>
        {:else if download.status === 'setup-complete' || download.status === 'seeding'}
          {#if download.status === 'setup-complete'}
            <p class="text-green-500 font-mono">SETUP COMPLETE</p>
          {/if}
          <button class="bg-accent-light text-black p-2 rounded" on:click={() => window.electronAPI.fs.showFileLoc(download.downloadPath)}>Show File Location</button>
        {:else if download.status === 'rd-downloading'}
          <p class="text-yellow-500 font-mono">Waiting for Real-Debrid to download torrent...</p>
        {:else if download.status === 'requesting'}
          <p class="text-yellow-500 font-mono">Requesting download from addon...</p>
        {:else}
          <section class="flex flex-row gap-8 w-full justify-center items-center p-4">
            <section class="flex-col flex w-1/3 justify-center items-center">
              <p class="text-blue-800 font-mono text-2xl">{Math.floor(download.progress * 100)}%</p>
              <p class="font-mono text-gray-400">DOWNLOADED</p>
            </section>
            <section class="flex-col flex w-1/3 justify-center items-center">
              <p class="text-yellow-500 font-mono text-2xl">{correctParsingSize(download.downloadSpeed)}/s</p>
              <p class="font-mono text-gray-400">SPEED</p>
            </section>
            <section class="flex-col flex w-1/3 justify-center items-center">
              <p class="text-gray-700 font-mono text-2xl">{correctParsingSize(download.downloadSize)}</p>
              <p class="font-mono text-gray-400">SIZE</p>
            </section>
          </section>

          {#if download.part !== undefined}
            <section class="flex flex-row gap-8 w-full justify-center items-center p-4">
              <section class="flex-col flex w-1/3 justify-center items-center">
                <p class="text-yellow-500 font-mono text-2xl">{download.part}</p>
                <p class="font-mono text-gray-400">CURR. PART</p>
              </section>
              <section class="flex-col flex w-1/3 justify-center items-center">
                <p class="text-green-500 font-mono text-2xl">{download.totalParts}</p>
                <p class="font-mono text-gray-400">TOTAL PARTS</p>
              </section>
            </section>
          {/if}
        {/if}

      </section>
    </div>
  {/each}
</div>

<style>
	.downloads {
		@apply flex flex-col gap-2 w-5/6 pb-8;
	}
	.downloads div {
		@apply border border-gray-200 rounded p-2 flex flex-row gap-2 w-full bg-slate-100 h-48 justify-center items-center;
	}

  .downloads img {
    @apply rounded-lg w-1/4 h-full;
  }

  .downloads h2 {
    @apply text-2xl;
  }

  progress {
    @apply w-[26rem] h-2 [&::-webkit-progress-bar]:rounded-lg [&::-webkit-progress-bar]:bg-accent-light;
  }
  ::-webkit-progress-value {
    @apply rounded-lg bg-accent;
  }
  
</style>