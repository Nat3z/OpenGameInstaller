<script lang="ts">
  let stage = 1;

  async function downloadTools(event: MouseEvent) {
    console.log("Downloading tools");
    const button = event.target as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Downloading...";
    await window.electronAPI.oobe.downloadTools();
    stage = 2;
  }
</script>

<main class="flex items-center flex-col justify-center w-full h-full p-8 bg-white fixed top-0 left-0 outline">
  {#if stage > 0}
    <progress class="animate-fade-in-slow" max="10" value={stage - 1}></progress>
  {/if}

  {#if stage === 0}
    <div class="animate-fade-in-pop flex justify-center items-center flex-col gap-4">
      <img src="./favicon.png" alt="OpenGameInstaller Logo" class="w-32 h-32" />
      <h1 class="text-4xl font-archivo">Welcome to OpenGameInstaller</h1> 
      <h2 class="animate-in-sub-content font-open-sans">An open-source game installer for your video games!</h2>

      <div class="animate-in-sub-content-slow">
        <button on:click={() => stage = 1} class="bg-accent hover:bg-accent-dark text-white font-open-sans font-bold py-2 px-4 rounded">Get Started</button>
      </div>
    </div>
  {:else if stage === 1}
    <div class="animate-fade-in-pop flex justify-start items-center h-full flex-col gap-4 p-10 w-full">
      <h1 class="text-3xl font-archivo font-semibold mt-6 mb-12">Install Tools</h1>

      <div class="w-full justify center items-center flex flex-col gap-4 mb-12">
        <div class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
          <div class="flex justify-center items-center w-16">
            <h4 class="font-archivo font-extrabold">7z</h4>
          </div>
          <span class="flex flex-col justify-start items-start">
            <span class="font-open-sans text-sm font-bold">7zip</span>
            <span class="font-open-sans text-xs">Required for unzipping .rar file extensions</span>
          </span>
        </div>    
        <div class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
          <img class="p-4 w-16 h-16" src="./bun.svg" />
          <span class="flex flex-col justify-start items-start">
            <span class="font-open-sans text-sm font-bold">Bun</span>
            <span class="font-open-sans text-xs">Required for executing addons</span>
          </span>
        </div>    
        <div class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
          <img class="p-4 w-16 h-16" src="./git.svg" />
          <span class="flex flex-col justify-start items-start">
            <span class="font-open-sans text-sm font-bold">Git</span>
            <span class="font-open-sans text-xs">Required for downloading addons</span>
          </span>
        </div>    
      </div>

      <button on:click={downloadTools} class="bg-accent hover:bg-accent-dark text-white disabled:text-white disabled:bg-yellow-300 font-open-sans font-semibold py-2 px-4 rounded">Install</button>
    </div>
  {/if}
</main>

<style scoped>
  progress {
    @apply fixed top-2 pr-2 pl-2 w-full h-2 [&::-webkit-progress-bar]:rounded-lg [&::-webkit-progress-bar]:bg-accent-light;
  }
  ::-webkit-progress-value {
    transition: width 1s;
    @apply rounded-lg bg-accent
  }
</style>