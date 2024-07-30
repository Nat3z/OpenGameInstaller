<script lang="ts">
  let stage = 0;
</script>

<main class="flex items-center flex-col justify-center w-full h-full bg-white fixed top-0 left-0 outline">
  {#if stage !== undefined}
    <div class="bg-black">
      <progress class="w-full" max="100" value="0"></progress>
    </div>
  {/if}

  {#if stage === 0}
    <div class="animate-fade-in-pop flex justify-center items-center flex-col gap-4">
      <img src="./favicon.png" alt="OpenGameInstaller Logo" class="w-32 h-32" />
      <h1 class="text-4xl">Welcome to OpenGameInstaller</h1> 
      <h2 class="animate-in-sub-content">An open-source game installer for your video games!</h2>

      <div class="animate-in-sub-content-slow">
        <button on:click={() => stage = 1} class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded">Get Started</button>
      </div>
    </div>
  {:else if stage === 1}
    <div class="animate-fade-in-pop flex justify-center items-center flex-col gap-4"></div>
  {/if}
</main>