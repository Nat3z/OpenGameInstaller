<script lang="ts">
  import { onMount } from "svelte";
  import { safeFetch } from "../utils";
  let addons: any[] = [];
  onMount(() => {
    safeFetch("http://localhost:7654/addons").then((data) => {
      addons = data;
    });
  });

  let selectedAddon: any = null;
  
  function selectAddon(addon: any) {
    const selected = document.querySelector(".selected");
    if (selected) {
      selected.classList.remove("selected");
    }
    const element = document.getElementById("cfg-" + addon.id);
    if (element) {
      element.classList.add("selected");
      selectedAddon = addon;
    }
  }

  
</script>

<div class="config">
  <div class="w-2/6 border-r-2 border-gray-800 h-full">
    <section class="selected hidden">
    </section>
    {#if addons.length !== 0}
      {#each addons as addon}
        <section class="" on:keypress={() => {}} on:click={() => selectAddon(addon)} id={"cfg-" + addon.id}>
          <h2>{addon.name}</h2>
          <p>{addon.description}</p>
        </section>
      {/each}
    {/if}
  </div>

  <article>
    {#if selectedAddon}
      <h2>{selectedAddon.name}</h2>
      <p>{selectedAddon.description}</p>
      <div class="options">
        <article>
          {#each Object.keys(selectedAddon.configTemplate) as key}
            <div class="flex flex-row gap-2">
              <label for={key}>{key}</label>
              {#if selectedAddon.configTemplate[key].type === "string"}
                <input type="text" id={key} maxlength={selectedAddon.configTemplate[key].maxTextLength} minlength={selectedAddon.configTemplate[key].minTextLength} />
              {/if}
              {#if selectedAddon.configTemplate[key].type === "number"}
                <input type="number" id={key} max={selectedAddon.configTemplate[key].max} min={selectedAddon.configTemplate[key].min} />
              {/if}
            </div>
          {/each}
        </article>
      </div>
    {/if}    
 
  </article>
</div>

<style>
  .selected {
    @apply bg-gray-400;
  }
	.config {
		@apply flex flex-row gap-2 bg-gray-300 w-5/6 h-5/6 border-gray-800 rounded;
	}
  section {
    @apply p-2;
  }
  section h2 {
    @apply text-xl;
  }
  section p {
    @apply text-sm text-gray-500; 
  }  
	section .download {
		@apply bg-blue-500 text-white p-2 rounded;
	}
	.games div article {
		@apply flex flex-col gap-2;
	}
	article h2 {
		@apply text-xl;
	}
	article p {
		@apply text-sm text-gray-500;
	}

</style>